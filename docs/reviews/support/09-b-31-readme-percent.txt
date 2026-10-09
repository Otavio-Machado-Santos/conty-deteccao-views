TAP version 13
# Subtest: FPR do README bate com a medição do generate:evaluate
not ok 1 - FPR do README bate com a medição do generate:evaluate
  ---
  duration_ms: 29.913959
  type: 'test'
  location: '/private/var/folders/1h/dnd2dd992cq41yhypgy46_bc0000gn/T/conty-review09-b-31-w5_fyl9w/test/readme-metrics.test.js:26:1'
  failureType: 'testCodeFailure'
  error: |-
    percentual do README (1%) diverge do medido (0%)
    
    1 !== 0
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///private/var/folders/1h/dnd2dd992cq41yhypgy46_bc0000gn/T/conty-review09-b-31-w5_fyl9w/test/readme-metrics.test.js:41:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.start (node:internal/test_runner/test:944:17)
    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
  ...
# Subtest: avaliação grava evaluation.json coerente com o cálculo
ok 2 - avaliação grava evaluation.json coerente com o cálculo
  ---
  duration_ms: 23.459292
  type: 'test'
  ...
# Subtest: reprodução byte a byte é confirmada na avaliação
ok 3 - reprodução byte a byte é confirmada na avaliação
  ---
  duration_ms: 22.669042
  type: 'test'
  ...
# Subtest: runEvaluation(writeEvidence:false) é somente leitura: não altera dataset nem grava evidence/README
ok 4 - runEvaluation(writeEvidence:false) é somente leitura: não altera dataset nem grava evidence/README
  ---
  duration_ms: 22.467042
  type: 'test'
  ...
1..4
# tests 4
# suites 0
# pass 3
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 145.063834
