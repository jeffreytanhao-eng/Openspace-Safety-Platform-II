import { parentPort, workerData } from 'node:worker_threads'
import { coarseScan, type CoarseInput } from './coarse.js'

// R0-3：粗筛进度上报（{type:'progress', step}），完成时 {type:'done', candidates}
const out = coarseScan(workerData as CoarseInput, (step) => {
  parentPort?.postMessage({ type: 'progress', step })
})
parentPort?.postMessage({ type: 'done', candidates: out })
