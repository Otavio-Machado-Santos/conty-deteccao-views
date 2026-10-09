# conty-deteccao-views

Classificador explicável de séries de **views incrementais por hora**. Recebe uma série cronológica contígua (timestamps UTC horários, inteiros seguros não negativos) e devolve `plausivel`, `suspeito` ou `inconclusivo`, com motivo legível em português e sinais quantitativos.

**Não é prova de fraude.** Séries horárias não permitem afirmar humanos ou bots com certeza. Tráfego pago legítimo, campanhas agendadas e picos orgânicos reais podem se parecer com compra. Séries idênticas são indistinguíveis por este método.

## Como rodar

Requer Node 22 (sem dependências externas).

```bash
npm start                 # API em http://127.0.0.1:3009
npm test                  # testes (node:test)
npm run generate:evaluate # regenera dataset e calcula FPR/matrix/recall
```

## Contrato da série

```json
{
  "series": [
    { "timestamp": "2026-01-05T00:00:00.000Z", "views": 102 },
    { "timestamp": "2026-01-05T01:00:00.000Z", "views": 98 }
  ]
}
```

- `timestamp`: ISO em UTC (`Z` ou `+00:00`), alinhado à hora cheia, passo exato de 1 hora, sem lacunas.
- `views`: inteiro seguro ≥ 0 — **incremental daquela hora**, não acumulado.

Violações do contrato retornam `422` com a regra violada.

## Exemplo real de request/response

Request (`POST /classify`):

```json
{
  "series": [
    { "timestamp": "2026-01-05T00:00:00.000Z", "views": 102 },
    { "timestamp": "2026-01-05T01:00:00.000Z", "views": 98 },
    { "timestamp": "2026-01-05T02:00:00.000Z", "views": 101 },
    { "timestamp": "2026-01-05T03:00:00.000Z", "views": 99 },
    { "timestamp": "2026-01-05T04:00:00.000Z", "views": 100 },
    { "timestamp": "2026-01-05T05:00:00.000Z", "views": 97 },
    { "timestamp": "2026-01-05T06:00:00.000Z", "views": 103 },
    { "timestamp": "2026-01-05T07:00:00.000Z", "views": 98 },
    { "timestamp": "2026-01-05T08:00:00.000Z", "views": 100 },
    { "timestamp": "2026-01-05T09:00:00.000Z", "views": 101 },
    { "timestamp": "2026-01-05T10:00:00.000Z", "views": 99 },
    { "timestamp": "2026-01-05T11:00:00.000Z", "views": 100 },
    { "timestamp": "2026-01-05T12:00:00.000Z", "views": 2000 },
    { "timestamp": "2026-01-05T13:00:00.000Z", "views": 1800 },
    { "timestamp": "2026-01-05T14:00:00.000Z", "views": 100 },
    { "timestamp": "2026-01-05T15:00:00.000Z", "views": 98 }
  ]
}
```

Response (resumo do JSON real devolvido por `http://127.0.0.1:3009/classify`):

```json
{
  "classification": "suspeito",
  "shape": "pico_abrupto",
  "reason": "Pico abrupto com magnitude concentrada: largura do pico = 2h; subida = 0h; descida = 1h; maior degrau na rampa = 20×; pico 2000 vs mediana 100 → razão 20×; hora do pico = 33.4% do total; top-3 horas = 65.1%; melhor janela de 3h = 65.0%. Subida/queda curtas e concentração alta combinadas são compatíveis com compra de views — indício, não prova.",
  "signals": {
    "peakToBase": { "value": 20, "threshold": 8, "triggered": true, "detail": "pico 2000 vs mediana 100 → razão 20×" },
    "abruptJump": { "value": 20, "threshold": 4, "triggered": true, "detail": "maior fator de subida hora a hora = 20× no índice 12" },
    "abruptDrop": { "value": 18, "threshold": 4, "triggered": true, "detail": "maior fator de queda hora a hora = 18× no índice 14" },
    "concentration": { "value": 0.3336, "top3Share": 0.6509, "threshold": 0.35, "triggered": true },
    "exactRepetition": { "value": 1, "triggered": false },
    "rampShape": { "value": { "spikeWidth": 2, "maxRampStep": 20 }, "triggered": false }
  },
  "disclaimer": "Resultado analítico, não prova de fraude: séries horárias de views não permitem afirmar humanos ou bots com certeza. ..."
}
```

## Sinais e limiares

| Sinal | O que mede | Limiar de destaque |
| --- | --- | --- |
| `peakToBase` | pico ÷ mediana da série | ≥ 8× |
| `abruptJump` / `abruptDrop` | maior fator multiplicativo hora a hora | ≥ 4× |
| `concentration` | fração do total na hora do pico / top-3 / melhor janela de 3h | ≥ 35% / 72% / 65% |
| `exactRepetition` | maior sequência de inteiros idênticos | ≥ 4 h, valor ≥ 40, e valor representativo |
| `rampShape` | largura do pico (horas acima da metade do range), degrau máximo | largura ≥ 4 h e degrau < 3,2× = rampa suave |

**Regras de decisão (ordem):**

1. **Abstinência:** menos de 6 pontos, menos de 80 views no total, ou pico < 15 → `inconclusivo`.
2. **Mecânico:** run de ≥ 4 horas com o mesmo valor (≥ 40, representativo) → `suspeito`.
3. **Pico abrupto:** (subida/queda abrupta **ou** pico curto com razão ≥ 4) **e** (razão pico/base alta **ou** concentração alta), sem rampa suave → `suspeito`.
4. **Rampa suave:** região elevada larga sem degrau abrupto, ainda que com pico alto → `plausivel` (viral orgânico).
5. **Pico/sinal isolado:** sinais parciais sem combinação → `inconclusivo` (**prefere não acusar**).
6. **Caso comum:** diurno, campanha sustentada, tráfego estável → `plausivel`.

Pico alto **sozinho** nunca leva a `suspeito`. É preciso combinar sinais de famílias diferentes (abruptez **e** magnitude/concentração, ou repetição exata com volume).

## Por que distingue os exemplos

- **Viral orgânico** (subida e queda graduais, largura ≥ 4 h, degraus < 3,2×): cai na regra 4, mesmo com razão pico/base de 8–15×. Teste: `test/classify.test.js` ("viral orgânico … não é acusado").
- **Pico comprado** (base ruidosa + 1–2 h de 15–60× + volta imediata): salto e queda ≥ 4×, pico curto, concentração alta → regra 3. Teste: mesma suíte distingue os dois no mesmo assert.
- **Ritmo mecânico** (5–9 h com o mesmo inteiro): regra 2. Teste dedicado.
- **Evento rápido legítimo / volume baixo:** abstenção (ver abaixo).

## Dataset sintético e métricas

- Gerado por `npm run generate:evaluate`, seed fixa `20261009`, PRNG determinística (mulberry32).
- Arquivo: `dataset/series.json` (~75 KB, cabe no repo). Reprodução byte a byte verificada na avaliação e em teste.
- Perfis: `diurno`, `viral_organico`, `campanha_sustentada`, `baixo_volume`, `evento_rapido` (legítimos) e `compra_abrupta`, `repeticao_mecanica` (suspeitos).
- **Rótulos são sintéticos** (regras do gerador). A taxa vale **apenas para este conjunto**; não estima produção real. Não otimizamos o dataset para inflar precisão: incluímos picos orgânicos altos, eventos rápidos ambíguos e baixo volume.

### Resultado medido (`npm run generate:evaluate`)

FPR: 0/72 (0%)

- Numerador = legítimos classificados como `suspeito` = **0**
- Denominador = séries com rótulo sintético legítimo = **72**
- Inconclusivo **não** conta como falso positivo (é abstinência).

Matriz de confusão (verdade sintética × predição) — 102 séries:

|  | plausivel | suspeito | inconclusivo |
| --- | ---: | ---: | ---: |
| legitimo | 55 | **0 (FP)** | 17 |
| suspeito | 0 | 30 | 0 |

- Recall da classe suspeita: **30/30 (100%)** — suspeitos sintéticos detectados / total suspeitos.
- Inconclusivos: **17** (12 `baixo_volume` + 5 `evento_rapido`).
- Números completos: `docs/evidence/evaluation.json`. Teste `test/readme-metrics.test.js` falha se esta linha `FPR:` divergir do medido (o teste **não** edita o README).

### Limitações do FPR

0/72 é a taxa **neste dataset sintético**, com política de abstenção (17 `inconclusivo` que preferem não acusar). Em produção a taxa não é 0%: tráfego pago legítimo com entrega muito irregular pode se parecer com compra; campanhas agendadas com entrega perfeitamente estável podem disparar o sinal mecânico; um atacante que calce ruído e rampa suave na compra não é distinguido de viral real. Séries byte a byte iguais são indistinguíveis — o método só vê volume por hora.

## Caso em que o classificador prefere não acusar

Perfil `evento_rapido` (legítimo): pico moderado (~2,5–5,3× a base) em 1–3 horas, com cauda de buzz e sem lances de 4×+ nem repetição exata. Exemplo de saída:

> `inconclusivo` — "Pico com sinais parciais (largura do pico = 2h; …), mas sem combinação suficiente de abruptez e concentração. Pode ser evento legítimo, campanha paga ou pico comprado: preferimos não acusar."

Mesmo parecendo "um pico", não vira `suspeito` sem combinação de sinais. Os 5 casos `inconclusivo` desse perfil e os 12 de `baixo_volume` são a abstinência deliberada. Existe também o teste explícito de abstenção em `test/classify.test.js`.

## Decisões que eu mudaria

1. **Separar "compra" de "tráfego pago irregular"** exigiria features externas (fonte de tráfego, geography, user-agents, retenção). Com só views/hora, o teto de acurácia é baixo de propósito.
2. **O sinal mecânico** podia ganhar uma janela (ex.: run de 4 h apenas no vale noturno com valor abaixo da mediana não dispara — já evitamos um falso positivo assim), mas o caso perfeito de campanha com entrega estável continuaria indistingível de bot.
3. **Limiares fixos** (8×, 4×, 35%) são auditáveis mas não se adaptam por conta/vertical. Preferiria calibração por perfil de criador com histórico, o que está fora do escopo.
4. **Classificação em 3 rótulos** foi a escolha certa para o custo de falso positivo; um score contínuo + calibração seria o próximo passo natural.

## Nota sobre IA

Primeira implementação e testes gerados pelo **MiMo CLI (modelo mimo-v2.6-pro)**. Coordenação e revisões independentes por **Codex** ocorrerão antes de publicação. **Nenhuma revisão humana é alegada.**

## Evidências

- `docs/evidence/test.txt` — saída real de `npm test` e checagem de sintaxe.
- `docs/evidence/evaluation.json` — saída estruturada de `npm run generate:evaluate`.
