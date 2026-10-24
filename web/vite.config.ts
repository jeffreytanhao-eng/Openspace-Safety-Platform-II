import { fileURLToPath, URL } from 'node:url'
import { cp } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { defineConfig, type Plugin, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import viteCompression from 'vite-plugin-compression'
import zlib from 'node:zlib'

/**
 * 复制 Cesium 引擎静态资源（Assets / Workers / ThirdParty / Widgets）到 public/cesium。
 * Cesium ESM 运行时按 window.CESIUM_BASE_URL 拉取 workers / 底图贴图 / 第三方资源，
 * cesiumEarth.ts 中把它指向 BASE_URL + 'cesium/'。
 */
function copyCesiumAssets(): Plugin {
  const base = fileURLToPath(new URL('./node_modules/cesium/Build/CesiumUnminified', import.meta.url))
  const dest = fileURLToPath(new URL('./public/cesium', import.meta.url))
  // dev 下 buildStart 与 configureServer 会同时触发，必须去重，否则两个 cp 并发
  // 互相 unlink 同一文件会抛 ENOENT 并中断 dev server 启动
  let pending: Promise<void> | null = null
  let copied = false
  const copy = (): Promise<void> => {
    if (copied) return Promise.resolve()
    if (pending) return pending
    pending = (async () => {
      mkdirSync(dest, { recursive: true })
      for (const dir of ['Assets', 'Workers', 'ThirdParty', 'Widgets']) {
        await cp(`${base}/${dir}`, `${dest}/${dir}`, { recursive: true, force: true })
      }
      copied = true
    })()
      .catch((err) => {
        console.warn('[cesium] 静态资源复制失败，请检查 node_modules/cesium：', err)
      })
      .finally(() => {
        pending = null
      })
    return pending
  }
  return { name: 'copy-cesium-assets', buildStart: copy, configureServer: () => copy() }
}

/** 本地开发时对响应做 gzip（生产由 nginx gzip_static 负责） */
function devGzip() {
  const COMPRESSIBLE = /^(application\/javascript|application\/json|text\/|image\/svg\+xml)/
  return {
    name: 'dev-gzip',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req: IncomingMessage, res: ServerResponse, next: (err?: unknown) => void) => {
        const accept = req.headers['accept-encoding']
        if (typeof accept !== 'string' || !accept.includes('gzip')) return next()

        const chunks: Buffer[] = []
        let shouldCompress = false
        const _write = res.write.bind(res)
        const _end = res.end.bind(res)

        const collect = (chunk: unknown) => {
          if (!chunk) return
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
        }
        const judge = () => {
          if (shouldCompress) return
          const type = res.getHeader('content-type')
          const ce = res.getHeader('content-encoding')
          shouldCompress =
            !ce &&
            !res.headersSent &&
            typeof type === 'string' &&
            COMPRESSIBLE.test(type) &&
            !type.startsWith('text/event-stream')
        }

        res.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
          judge()
          if (!shouldCompress) return _write(chunk as never, encoding as never, cb as never)
          collect(chunk)
          if (typeof cb === 'function') (cb as () => void)()
          return true
        }) as ServerResponse['write']

        res.end = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
          judge()
          if (!shouldCompress) return _end(chunk as never, encoding as never, cb as never)
          collect(chunk)
          const body = Buffer.concat(chunks)
          res.removeHeader('Content-Length')
          res.setHeader('Content-Encoding', 'gzip')
          res.setHeader('Vary', 'Accept-Encoding')
          zlib.gzip(body, (err, gz) => {
            if (err) {
              _write(body)
              return _end(cb as never)
            }
            res.setHeader('Content-Length', gz.length)
            _write(gz)
            _end(cb as never)
          })
        }) as ServerResponse['end']

        next()
      })
    }
  }
}

/** 代理目标：本地开发默认 127.0.0.1:1234（与 api 端口一致） */
const PROXY_TARGET = process.env.VITE_PROXY_TARGET || 'http://127.0.0.1:1234/'

export default defineConfig(() => ({
  plugins: [
    vue(),
    devGzip(),
    copyCesiumAssets(),
    // 构建产物生成 .gz 预压缩文件，nginx 直接下发
    viteCompression({ algorithm: 'gzip', threshold: 1024 })
  ],
  // 部署在域名子路径时用 VITE_BASE=/xxx/ 覆盖
  base: process.env.VITE_BASE || '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url))
    }
  },
  server: {
    host: true,
    port: 1233,
    allowedHosts: true,
    hmr: false,
    proxy: {
      '/cgi': {
        target: PROXY_TARGET,
        changeOrigin: false,
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ code: 502, msg: '后端服务未就绪，请稍后重试', data: null }))
          })
        }
      },
      '/uploads': {
        target: PROXY_TARGET,
        changeOrigin: false
      }
    }
  },
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    commonjsOptions: { exclude: [/node_modules[\\/]satellite\.js/] },
    chunkSizeWarningLimit: 2000,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['vue', 'vue-router', 'pinia', 'axios'],
          cesium: ['cesium']
        }
      }
    }
  },
  optimizeDeps: {
    esbuildOptions: { target: 'es2022' }
  }
}))
