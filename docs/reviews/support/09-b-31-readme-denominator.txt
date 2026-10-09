TAP version 13
# Subtest: FPR do README bate com a medição do generate:evaluate
not ok 1 - FPR do README bate com a medição do generate:evaluate
  ---
  duration_ms: 30.159625
  type: 'test'
  location: '/private/var/folders/1h/dnd2dd992cq41yhypgy46_bc0000gn/T/conty-review09-b-31-w5_fyl9w/test/readme-metrics.test.js:26:1'
  failureType: 'testCodeFailure'
  error: |-
    denominador do README (73) diverge do medido (72)
    
    73 !== 72
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 72
  actual: 73
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///private/var/folders/1h/dnd2dd992cq41yhypgy46_bc0000gn/T/conty-review09-b-31-w5_fyl9w/test/readme-metrics.test.js:36:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.start (node:internal/test_runner/test:944:17)
    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
  ...
# Subtest: avaliação grava evaluation.json coerente com o cálculo
ok 2 - avaliação grava evaluation.json coerente com o cálculo
  ---
  duration_ms: 23.646166
  type: 'test'
  ...
# Subtest: reprodução byte a byte é confirmada na avaliação
ok 3 - reprodução byte a byte é confirmada na avaliação
  ---
  duration_ms: 22.38925
  type: 'test'
  ...
# Subtest: runEvaluation(writeEvidence:false) é somente leitura: não altera dataset nem grava evidence/README
ok 4 - runEvaluation(writeEvidence:false) é somente leitura: não altera dataset nem grava evidence/README
  ---
  duration_ms: 22.069417
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
# duration_ms 146.282083
