import { validateSeries, SeriesValidationError } from './validate.js';
import { computeSignals } from './signals.js';

/**
 * Classificador explicável de views incrementais por hora.
 *
 * Rótulos:
 * - "plausivel"   → padrão compatível com tráfego legítimo (inclusive viral orgânico)
 * - "suspeito"    → combinação de sinais de pico comprado / ritmo mecânico
 * - "inconclusivo"→ poucos dados, volume baixo ou pico isolado ambíguo (abstinência)
 *
 * Isto NÃO é prova de fraude. Séries horárias não permitem afirmar
 * humanos vs. bots com certeza: tráfego pago legítimo, campanhas agendadas
 * e séries idênticas são indistinguíveis a partir só do volume por hora.
 */

export const CLASSIFICATIONS = Object.freeze({
  PLAUSIBLE: 'plausivel',
  SUSPICIOUS: 'suspeito',
  INCONCLUSIVE: 'inconclusivo',
});

export const THRESHOLDS = Object.freeze({
  MIN_POINTS: 6,
  MIN_TOTAL_VIEWS: 80,
  MIN_PEAK_FOR_MAGNITUDE: 15,
  HIGH_PEAK_TO_BASE: 8,
  HIGH_PEAK_SHARE: 0.35,
  HIGH_TOP3_SHARE: 0.72,
  HIGH_WINDOW3_SHARE: 0.65,
  // Fator multiplicativo hora a hora (≥ 4× em uma hora é abrupto).
  ABRUPT_JUMP_RATIO: 4,
  ABRUPT_DROP_RATIO: 4,
  NARROW_SPIKE_WIDTH: 2,
  NARROW_SPIKE_MIN_PEAK_TO_BASE: 4,
  WIDE_RAMP_WIDTH: 4,
  SMOOTH_MAX_RAMP_STEP: 3.2,
  MECHANICAL_RUN: 4,
  MECHANICAL_VALUE_MIN: 40,
  MECHANICAL_SHARE: 0.25,
  ORGANIC_MIN_PEAK_TO_BASE: 3,
});

const DISCLAIMER =
  'Resultado analítico, não prova de fraude: séries horárias de views não permitem afirmar humanos ou bots com certeza. Tráfego pago legítimo, campanhas agendadas e picos orgânicos reais podem se parecer com compra. Séries idênticas são indistinguíveis por este método.';

/**
 * @param {Array<{timestamp: string|Date, views: number}>|number[]} input
 *        pontos da API ou apenas o array de views
 * @param {{startMs?: number, now?: Date}} [options]
 */
export function classify(input, options = {}) {
  let views;
  let startMs = options.startMs ?? 0;

  if (Array.isArray(input) && input.length > 0 && typeof input[0] === 'object') {
    try {
      const parsed = validateSeries(input);
      views = parsed.views;
      startMs = parsed.startMs;
    } catch (err) {
      if (err instanceof SeriesValidationError) {
        return result(
          CLASSIFICATIONS.INCONCLUSIVE,
          `Série fora do contrato (${err.message}). Valores inválidos não viram suspeito.`,
          'invalida',
          {},
        );
      }
      throw err;
    }
  } else if (Array.isArray(input)) {
    views = input;
  } else {
    return {
      classification: CLASSIFICATIONS.INCONCLUSIVE,
      reason:
        'Entrada inválida: esperava uma série de pontos horários ou um array de views incrementais.',
      shape: 'invalida',
      signals: {},
      thresholds: THRESHOLDS,
      disclaimer: DISCLAIMER,
    };
  }

  if (views.length === 0) {
    return result(
      CLASSIFICATIONS.INCONCLUSIVE,
      'Série vazia: sem pontos horários para avaliar.',
      'invalida',
      {},
    );
  }

  for (const v of views) {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || !Number.isSafeInteger(v)) {
      return result(
        CLASSIFICATIONS.INCONCLUSIVE,
        'Valores de views devem ser inteiros seguros não negativos (views incrementais por hora).',
        'invalida',
        {},
      );
    }
  }

  const signals = computeSignals(views, startMs);
  const t = THRESHOLDS;

  // --- Abstinência por falta de evidência ---------------------------------
  if (signals.n < t.MIN_POINTS) {
    return result(
      CLASSIFICATIONS.INCONCLUSIVE,
      `Série curta (${signals.n} horas). Com menos de ${t.MIN_POINTS} pontos horários a classificação seria chute; preferimos não acusar.`,
      'curta',
      signals,
    );
  }

  if (signals.total < t.MIN_TOTAL_VIEWS) {
    return result(
      CLASSIFICATIONS.INCONCLUSIVE,
      `Volume total baixo (${signals.total} views em ${signals.n} horas). Abaixo de ${t.MIN_TOTAL_VIEWS} views os sinais de pico e repetição são ruidosos; preferimos não acusar.`,
      'baixo_volume',
      signals,
    );
  }

  if (signals.peak < t.MIN_PEAK_FOR_MAGNITUDE) {
    return result(
      CLASSIFICATIONS.INCONCLUSIVE,
      `Pico horário baixo (${signals.peak} views). Sem magnitude suficiente, razão e concentração não sustentam classificação.`,
      'pico_baixo',
      signals,
    );
  }

  // --- Flags de sinais (cada uma auditável) --------------------------------
  // Pico "curto" só conta como sinal de spike se a razão pico/base for
  // relevante — senão toda série ruidosa teria largura 1–2 na metade do range.
  const flags = {
    abruptJump: signals.maxRiseRatio >= t.ABRUPT_JUMP_RATIO,
    abruptDrop: signals.maxDropRatio >= t.ABRUPT_DROP_RATIO,
    highPeakToBase: signals.peakToBase >= t.HIGH_PEAK_TO_BASE,
    highConcentration:
      signals.peakShare >= t.HIGH_PEAK_SHARE ||
      signals.top3Share >= t.HIGH_TOP3_SHARE ||
      signals.window3Share >= t.HIGH_WINDOW3_SHARE,
    narrowSpike:
      signals.spikeWidth <= t.NARROW_SPIKE_WIDTH &&
      signals.peakToBase >= t.NARROW_SPIKE_MIN_PEAK_TO_BASE,
    // Repetição exata de valor não-trivial por várias horas é rara em tráfego
    // orgânico (que tem ruído). Exigimos que o valor repetido seja
    // representativo — run curta num vale de baixa atividade (abaixo da
    // mediana, participação pequena) é coincidência de arredondamento,
    // não ritmo mecânico de entrega.
    mechanical:
      signals.maxIdenticalRun >= t.MECHANICAL_RUN &&
      signals.runValue >= t.MECHANICAL_VALUE_MIN &&
      (signals.runValue >= signals.median ||
        signals.runShare >= t.MECHANICAL_SHARE ||
        signals.maxIdenticalRun >= 5),
    // Rampa suave = região elevada larga sem degrau abrupto hora a hora.
    smoothRamp:
      signals.spikeWidth >= t.WIDE_RAMP_WIDTH &&
      signals.maxRampStep < t.SMOOTH_MAX_RAMP_STEP &&
      signals.maxRiseRatio < t.ABRUPT_JUMP_RATIO &&
      signals.maxDropRatio < t.ABRUPT_DROP_RATIO,
  };

  const signalSummary = {
    peakToBase: {
      value: signals.peakToBase,
      threshold: t.HIGH_PEAK_TO_BASE,
      triggered: flags.highPeakToBase,
      detail: `pico ${signals.peak} vs mediana ${signals.median} → razão ${signals.peakToBase}×`,
    },
    abruptJump: {
      value: signals.maxRiseRatio,
      threshold: t.ABRUPT_JUMP_RATIO,
      triggered: flags.abruptJump,
      detail: `maior fator de subida hora a hora = ${signals.maxRiseRatio}× no índice ${signals.maxRiseIdx}`,
    },
    abruptDrop: {
      value: signals.maxDropRatio,
      threshold: t.ABRUPT_DROP_RATIO,
      triggered: flags.abruptDrop,
      detail: `maior fator de queda hora a hora = ${signals.maxDropRatio}× no índice ${signals.maxDropIdx}`,
    },
    concentration: {
      value: signals.peakShare,
      top3Share: signals.top3Share,
      window3Share: signals.window3Share,
      threshold: t.HIGH_PEAK_SHARE,
      triggered: flags.highConcentration,
      detail: `hora do pico = ${(signals.peakShare * 100).toFixed(1)}% do total; top-3 horas = ${(signals.top3Share * 100).toFixed(1)}%; melhor janela de 3h = ${(signals.window3Share * 100).toFixed(1)}%`,
    },
    exactRepetition: {
      value: signals.maxIdenticalRun,
      runValue: signals.runValue,
      runShare: signals.runShare,
      threshold: t.MECHANICAL_RUN,
      triggered: flags.mechanical,
      detail: `maior sequência de valores idênticos = ${signals.maxIdenticalRun} horas com ${signals.runValue} views (${(signals.runShare * 100).toFixed(1)}% do total)`,
    },
    rampShape: {
      value: {
        spikeWidth: signals.spikeWidth,
        riseHours: signals.riseHours,
        fallHours: signals.fallHours,
        maxRampStep: signals.maxRampStep,
      },
      threshold: {
        wideWidth: t.WIDE_RAMP_WIDTH,
        smoothMaxStep: t.SMOOTH_MAX_RAMP_STEP,
      },
      triggered: flags.smoothRamp,
      detail: `largura do pico = ${signals.spikeWidth}h; subida = ${signals.riseHours}h; descida = ${signals.fallHours}h; maior degrau na rampa = ${signals.maxRampStep}×`,
    },
  };

  // --- Padrão mecânico com volume suficiente ------------------------------
  // Combinação: (1) repetição exata longa; (2) valor repetido não-trivial;
  // (3) volume total da série já passou o piso. Tráfego orgânico tem ruído e
  // quase nunca produz inteiros idênticos em sequência; campanha com entrega
  // perfeitamente estável é o principal falso positivo deste sinal.
  if (flags.mechanical) {
    return result(
      CLASSIFICATIONS.SUSPICIOUS,
      `Ritmo mecânico: ${signalSummary.exactRepetition.detail}. Séries orgânicas têm ruído hora a hora; ${signals.maxIdenticalRun} horas com exatamente ${signals.runValue} views, em série com ${signals.total} views no total, combinam repetição exata e volume — indício de padrão automatizado, não prova de fraude.`,
      'mecanica',
      signals,
      signalSummary,
      flags,
    );
  }

  const spikeFamily = flags.abruptJump || flags.abruptDrop || flags.narrowSpike;
  const magnitudeFamily = flags.highPeakToBase || flags.highConcentration;

  // --- Pico abrupto comprado: exige famílias de sinais combinadas ---------
  if (!flags.smoothRamp && spikeFamily && magnitudeFamily) {
    const needsBothEdges =
      flags.narrowSpike || (flags.abruptJump && flags.abruptDrop);
    if (needsBothEdges) {
      return result(
        CLASSIFICATIONS.SUSPICIOUS,
        `Pico abrupto com magnitude concentrada: ${signalSummary.rampShape.detail}; ${signalSummary.peakToBase.detail}; ${signalSummary.concentration.detail}. Subida/queda curtas e concentração alta combinadas são compatíveis com compra de views — indício, não prova.`,
        'pico_abrupto',
        signals,
        signalSummary,
        flags,
      );
    }
  }

  // --- Rampa suave (viral orgânico): não acusar só por pico alto ----------
  if (flags.smoothRamp && (flags.highPeakToBase || signals.peakToBase >= t.ORGANIC_MIN_PEAK_TO_BASE)) {
    return result(
      CLASSIFICATIONS.PLAUSIBLE,
      `Subida e descida graduais (${signalSummary.rampShape.detail}) com razão pico/base de ${signals.peakToBase}×. Forma de rampa suave é compatível com viral orgânico ou evento legítimo com propagação; pico alto sozinho não caracteriza compra.`,
      'rampa_suave',
      signals,
      signalSummary,
      flags,
    );
  }

  // --- Pico isolado ambíguo: preferir não acusar --------------------------
  if (spikeFamily && magnitudeFamily) {
    return result(
      CLASSIFICATIONS.INCONCLUSIVE,
      `Pico com sinais parciais (${signalSummary.rampShape.detail}; ${signalSummary.peakToBase.detail}), mas sem combinação suficiente de abruptez e concentração. Pode ser evento legítimo, campanha paga ou pico comprado: preferimos não acusar.`,
      'pico_ambiguo',
      signals,
      signalSummary,
      flags,
    );
  }

  if (spikeFamily || magnitudeFamily) {
    return result(
      CLASSIFICATIONS.INCONCLUSIVE,
      `Sinal isolado sem combinação (${signalSummary.rampShape.detail}; ${signalSummary.concentration.detail}). Um único indicador não sustenta classificação; preferimos não acusar.`,
      'sinal_isolado',
      signals,
      signalSummary,
      flags,
    );
  }

  // --- Caso comum: diurno / campanha sustentada / tráfego estável --------
  const shapeNote = flags.smoothRamp
    ? 'rampa suave'
    : signals.spikeWidth >= t.WIDE_RAMP_WIDTH
      ? 'elevação distribuída (compatível com campanha sustentada ou padrão diurno)'
      : 'variação moderada sem configuração de pico comprado';
  const quietNote =
    !flags.abruptJump && !flags.abruptDrop
      ? 'sem saltos extremos'
      : 'com variação hora a hora que não se combina a concentração de pico';

  return result(
    CLASSIFICATIONS.PLAUSIBLE,
    `Série sem combinação de sinais de compra (${shapeNote}). Razão pico/base ${signals.peakToBase}×, concentração ${(signals.peakShare * 100).toFixed(1)}% na hora do pico, ${quietNote}. Compatível com tráfego legítimo.`,
    'legitimo_estavel',
    signals,
    signalSummary,
    flags,
  );
}

function result(classification, reason, shape, signals, signalSummary = {}, flags = {}) {
  return {
    classification,
    reason,
    shape,
    signals: signalSummary,
    rawMetrics: signals,
    flags,
    thresholds: THRESHOLDS,
    disclaimer: DISCLAIMER,
  };
}

export { DISCLAIMER };
