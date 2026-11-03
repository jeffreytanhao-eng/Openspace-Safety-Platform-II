import { parentPort, workerData } from 'node:worker_threads'
import { coarseScan, type CoarseInput } from './coarse.js'

const out = coarseScan(workerData as CoarseInput)
parentPort?.postMessage(out)
