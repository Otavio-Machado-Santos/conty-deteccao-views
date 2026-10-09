TAP version 13
# Subtest: FPR do README bate com a medição do generate:evaluate
not ok 1 - FPR do README bate com a medição do generate:evaluate
  ---
  duration_ms: 26.976667
  type: 'test'
  location: '/private/var/folders/1h/dnd2dd992cq41yhypgy46_bc0000gn/T/conty-review09-b-jj4i9vmp/test/readme-metrics.test.js:26:1'
  failureType: 'testCodeFailure'
  error: |-
    numerador do README (1) diverge do medido (0)
    
    1 !== 0
    
  code: 'ERR_ASSERTION'
  name: 'AssertionError'
  expected: 0
  actual: 1
  operator: 'strictEqual'
  stack: |-
    TestContext.<anonymous> (file:///private/var/folders/1h/dnd2dd992cq41yhypgy46_bc0000gn/T/conty-review09-b-jj4i9vmp/test/readme-metrics.test.js:31:10)
    Test.runInAsyncScope (node:async_hooks:214:14)
    Test.run (node:internal/test_runner/test:1047:25)
    Test.start (node:internal/test_runner/test:944:17)
    startSubtestAfterBootstrap (node:internal/test_runner/harness:296:17)
  ...
# Subtest: avaliação grava evaluation.json coerente com o cálculo
ok 2 - avaliação grava evaluation.json coerente com o cálculo
  ---
  duration_ms: 20.112416
  type: 'test'
  ...
# Subtest: reprodução byte a byte é confirmada na avaliação
ok 3 - reprodução byte a byte é confirmada na avaliação
  ---
  duration_ms: 18.509375
  type: 'test'
  ...
1..3
# tests 3
# suites 0
# pass 2
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 115.265583
