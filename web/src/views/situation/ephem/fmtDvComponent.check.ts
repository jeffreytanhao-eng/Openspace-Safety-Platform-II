/**
 * Unit check for fmtDvComponent / manDvVectorPhrase near-zero rules.
 * Run from web/:  node --experimental-strip-types --no-warnings src/views/situation/ephem/fmtDvComponent.check.ts
 */
import assert from 'node:assert/strict'
import { fmtDvComponent, fmtDvMps, manDvVectorPhrase } from './maneuverDisplay.ts'

const checks: Array<[string, () => void]> = [
  ['exact 0', () => assert.equal(fmtDvComponent(0), '0.000')],
  ['exact -0', () => assert.equal(fmtDvComponent(-0), '0.000')],
  ['float residue 6.94e-18 → 0.000', () => assert.equal(fmtDvComponent(6.94e-18, 0.093), '0.000')],
  ['3.68e-5 with |Δv|≈0.093 → 0.000 (0.04% < 0.1%)', () => assert.equal(fmtDvComponent(3.68e-5, 0.093), '0.000')],
  ['-4.19e-6 with |Δv|≈0.111 → 0.000', () => assert.equal(fmtDvComponent(-4.19e-6, 0.111), '0.000')],
  ['7.88e-5 with |Δv|≈0.096 → 0.000', () => assert.equal(fmtDvComponent(7.88e-5, 0.096), '0.000')],
  ['significant 0.002 uses 3 decimals', () => assert.equal(fmtDvComponent(0.002, 0.093), '0.002')],
  ['0.0005 > 0.1% of 0.1 uses scientific', () => assert.equal(fmtDvComponent(0.0005, 0.1), '5.00e-4')],
  ['-0.0005 > 0.1% of 0.1 keeps sign in scientific', () => assert.equal(fmtDvComponent(-0.0005, 0.1), '-5.00e-4')],
  ['0.093 uses 3 decimals', () => assert.equal(fmtDvComponent(0.093, 0.093), '0.093')],
  ['without mag, 3.68e-5 stays scientific (|x|>=1e-6)', () => assert.equal(fmtDvComponent(3.68e-5), '3.68e-5')],
  ['without mag, 6.94e-18 still 0.000', () => assert.equal(fmtDvComponent(6.94e-18), '0.000')],
  ['fmtDvMps magnitude unchanged (0.076)', () => assert.equal(fmtDvMps(0.076), '0.076 m/s')],
  ['fmtDvMps exact 0 unchanged', () => assert.equal(fmtDvMps(0), '0 m/s')],
  ['fmtDvMps tiny scientific unchanged', () => assert.equal(fmtDvMps(3.68e-5), '3.68e-5 m/s')],
  [
    'STARLINK-37711-like UVW phrase (UVW file components, no r/v)',
    () => {
      // duraSec=100 → component m/s = acc(km/s²) * 100 * 1000
      const phrase = manDvVectorPhrase({
        acc: [3.68e-5 / 1e5, 0.093 / 1e5, 6.94e-18 / 1e5],
        duraSec: 100,
        refFrame: 'UVW'
      })
      assert.equal(phrase, 'Δv = (0.000 U, 0.093 V, 0.000 W) m/s')
    }
  ],
  [
    'second burn |Δv|≈0.111',
    () => {
      const phrase = manDvVectorPhrase({
        acc: [-4.19e-6 / 1e5, 0.111 / 1e5, 0],
        duraSec: 100,
        refFrame: 'UVW'
      })
      assert.equal(phrase, 'Δv = (0.000 U, 0.111 V, 0.000 W) m/s')
    }
  ],
  [
    'third burn |Δv|≈0.096',
    () => {
      const phrase = manDvVectorPhrase({
        acc: [7.88e-5 / 1e5, 0.096 / 1e5, 0],
        duraSec: 100,
        refFrame: 'UVW'
      })
      assert.equal(phrase, 'Δv = (0.000 U, 0.096 V, 0.000 W) m/s')
    }
  ],
  [
    'significant small U is not zeroed (0.002)',
    () => {
      const phrase = manDvVectorPhrase({
        acc: [0.002 / 1e5, 0.093 / 1e5, 0],
        duraSec: 100,
        refFrame: 'UVW'
      })
      assert.equal(phrase, 'Δv = (0.002 U, 0.093 V, 0.000 W) m/s')
    }
  ]
]

let failed = 0
for (const [name, fn] of checks) {
  try {
    fn()
    console.log('ok  ', name)
  } catch (err) {
    failed++
    console.error('FAIL', name, err)
  }
}
if (failed) {
  console.error(`\n${failed} failed / ${checks.length}`)
  process.exit(1)
}
console.log(`\n${checks.length} passed`)
