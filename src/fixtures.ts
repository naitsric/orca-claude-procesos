// Un sistema inventado para las pruebas y para `orca plugin check`:
// - una sesión viva en Orca (4129) con dos MCP, caffeinate y un `npm run dev` de hace 1 h 30;
// - una sesión que murió (5000) y dejó vivo su mcp-grafana (5001) con un hijo;
// - un shell de Bash suelto (8800) con un túnel SSM en :15432;
// - un servidor MCP sin dueño conocido (8900) y un `npm start` de launchd que no es de Claude;
// - seis worktrees del repositorio mi-app: dos inactivos sin nada que perder, uno inactivo con
//   cambios, uno de un subagente de la sesión viva, uno con actividad de hoy y un workspace de Orca.
import { agrupar, armarFoto, leerInfoClaude, memoriaVacia, parsearPs, type InfoClaude, type Memoria } from './procesos'
import type { Foto } from './tipos'
import { agregarWorktrees, type LecturaWorktree } from './worktrees'

export const AHORA = Date.UTC(2026, 10, 13, 18, 0, 0)
export const UID = 501
export const HOME = '/Users/u'

const SNAP = '/Users/u/.claude/shell-snapshots/snapshot-zsh-1.sh'

export const PS = [
  '    1     0     1     0 ??       2-00:00:00   1000   0.0    0:00.00 /sbin/launchd',
  ' 1668     1  1668   501 ??         22:00:00  70000   0.4    0:00.00 /Users/u/Library/Application Support/orca/daemon-host/Orca Terminal Host.app/Contents/MacOS/orca-terminal-host',
  ' 4057  1668  4057     0 ttys009     2:00:05   7000   0.0    0:00.00 /usr/bin/login -flpq u /bin/bash --noprofile --norc -p -c exec -l -- "$@" orca-tcc-login /bin/zsh /bin/zsh -l',
  ' 4058  4057  4058   501 ttys009     2:00:04   1000   0.0    0:00.00 -zsh',
  ' 4129  4058  4129   501 ttys009     2:00:00 400000   3.0    0:00.00 claude --resume 7d1e9a42-bbbb',
  ' 4154  4129  4129   501 ttys009     1:59:59  20000   0.0    0:00.00 /Users/u/.local/bin/uv tool uvx awslabs.aws-mcp',
  ' 4160  4154  4129   501 ttys009     1:59:58  15000   0.0    0:00.00 /Users/u/.cache/uv/bin/python -m aws_mcp',
  ' 4281  4129  4129   501 ttys009     1:59:50  15000   0.0    0:00.00 mcp-grafana',
  ' 7766  4129  4129   501 ttys009        02:00   1000   0.0    0:00.00 caffeinate -i -t 300',
  ` 9214  4129  9214   501 ??          1:30:00   1000   0.0    0:00.00 /bin/zsh -c source ${SNAP} 2>/dev/null || true && eval 'npm run dev -- --port '\\''5173'\\''' < /dev/null && pwd -P >| /tmp/x`,
  ' 9220  9214  9214   501 ??          1:29:59  80000   0.0    0:00.00 node /Users/u/app/node_modules/.bin/vite',
  ' 5001     1  5000   501 ??          3:00:00  30000   0.0    0:00.00 mcp-grafana',
  ' 5002  5001  5000   501 ??          3:00:00   5000   0.0    0:00.00 /usr/bin/python3 helper.py',
  ' 8000     1  8000   501 ??         20:00:00   3000   0.0    0:00.00 npm start',
  ` 8800     1  8800   501 ??            50:00   9000   0.0    0:00.00 /bin/zsh -c source ${SNAP} 2>/dev/null || true && eval 'aws ssm start-session --target i-1' < /dev/null`,
  ' 8801  8800  8800   501 ??            50:00  20000   0.0    0:00.00 session-manager-plugin {"SessionId":"x"} us-west-2 StartSession',
  ' 8900     1  8900   501 ??          5:00:00  15000   0.0    0:00.00 node /Users/u/.npm/_npx/abc/node_modules/.bin/mcp-server-filesystem /tmp'
].join('\n')

export const COMM = [
  '    1 /sbin/launchd',
  ' 1668 /Users/u/Library/Application Support/orca/daemon-host/Orca Terminal Host.app/Contents/MacOS/orca-terminal-host',
  ' 4057 /usr/bin/login',
  ' 4058 -zsh',
  ' 4129 claude',
  ' 4154 /Users/u/.local/bin/uv',
  ' 4160 /Users/u/.cache/uv/bin/python',
  ' 4281 mcp-grafana',
  ' 7766 caffeinate',
  ' 9214 /bin/zsh',
  ' 9220 node',
  ' 5001 mcp-grafana',
  ' 5002 /usr/bin/python3',
  ' 8000 npm',
  ' 8800 /bin/zsh',
  ' 8801 session-manager-plugin',
  ' 8900 node'
].join('\n')

/** Un proceso que el shell 9214 lanzó con nohup: cuelga de launchd pero conserva el grupo. */
export const PS_DESACOPLADO = ' 9300     1  9214   501 ??            10:00  40000   0.0    0:00.00 node /Users/u/app/server.js'
export const COMM_DESACOPLADO = ' 9300 node'

export const PUERTOS = new Map<number, number[]>([
  [9220, [5173]],
  [8801, [15432]],
  [9300, [8080]]
])

export const CWDS = new Map<number, string>([
  [4129, '/Users/u/www/mi-app'],
  [5001, '/Users/u/www/old'],
  [8800, '/Users/u/www/mi-app'],
  [8900, '/tmp']
])

/** `~/.claude/sessions/4129.json`: la sesión viva espera un mensaje desde hace 20 h. */
export function infosDePrueba(ahora = AHORA): Map<number, InfoClaude> {
  const inicio = new Date(AHORA - 2 * 3600_000)
  const procStart = inicio.toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) ([\d:]+) GMT$/, '$1 $3 $2 $5 $4')
  const json = JSON.stringify({
    pid: 4129,
    sessionId: '0f3c2a9e-5b1d-4c7a-9e2f-7a6b5c4d3e21',
    cwd: '/Users/u/www/mi-app',
    startedAt: inicio.getTime() + 800,
    procStart,
    name: 'mi-app-c7',
    status: 'idle',
    statusUpdatedAt: ahora - 20 * 3600_000
  })
  return new Map([[4129, leerInfoClaude(json)!]])
}

/** Lo que el plugin recordaba de la sesión 5000, que murió hace una hora. */
export function memoriaConSesionMuerta(): Memoria {
  const m = memoriaVacia()
  const inicio = AHORA - 3 * 3600_000 - 10_000
  m.sesiones['5000@1'] = { pid: 5000, inicio, pgid: 5000, cwd: '/Users/u/www/old', vista: AHORA - 3600_000, termino: null }
  m.grupos['5000'] = { sesion: '5000@1', inicio }
  return m
}

export function revisarFixture(
  memoria: Memoria,
  extra: { ps?: string; comm?: string; infos?: Map<number, InfoClaude> } = {},
  ahora = AHORA
): { foto: Foto; memoria: Memoria } {
  const ps = extra.ps ? `${PS}\n${extra.ps}` : PS
  const comm = extra.comm ? `${COMM}\n${extra.comm}` : COMM
  const a = agrupar(parsearPs(ps, comm, ahora), memoria, UID)
  return armarFoto(a, PUERTOS, CWDS, memoria, { ahora, horasSesionLarga: 12, home: HOME }, extra.infos)
}

const UN_DIA = 24 * 3600_000
export const REPO = '/Users/u/www/mi-app'
export const DIAS_INACTIVO = 7

/** Lo que src/git.ts leería de los worktrees de mi-app. */
export function lecturasDePrueba(ahora = AHORA): LecturaWorktree[] {
  const base = { repo: REPO, bloqueo: null, falta: false, cambios: 0, sinSeguir: 0, sinSubir: null, commitsSueltos: 0 }
  return [
    {
      ...base,
      ruta: `${REPO}/.claude/worktrees/feat+pagos`,
      head: 'a1a1a1a',
      rama: 'worktree-feat+pagos',
      sinSubir: 2,
      ultimaActividad: ahora - 12 * UN_DIA,
      kb: 348_160
    },
    {
      // Lo bloqueó un subagente de la sesión 5000, que ya murió.
      ...base,
      ruta: `${REPO}/.claude/worktrees/agent-a1b2c3`,
      head: 'b2b2b2b',
      rama: 'feat/exportar',
      bloqueo: 'claude agent agent-a1b2c3 (pid 5000 start Fri Oct 16 09:00:00 2026)',
      ultimaActividad: ahora - 28 * UN_DIA,
      kb: 512_000
    },
    {
      ...base,
      ruta: `${REPO}/.claude/worktrees/fix+login`,
      head: 'c3c3c3c',
      rama: 'fix/login',
      cambios: 2,
      sinSeguir: 1,
      ultimaActividad: ahora - 9 * UN_DIA,
      kb: 201_000
    },
    {
      // De un subagente de la sesión viva (4129).
      ...base,
      ruta: `${REPO}/.claude/worktrees/agent-d4e5f6`,
      head: 'd4d4d4d',
      rama: 'feat/busqueda',
      bloqueo: 'claude agent agent-d4e5f6 (pid 4129 start Fri Nov 13 16:00:00 2026)',
      ultimaActividad: ahora - 10 * 60_000,
      kb: 90_000
    },
    {
      ...base,
      ruta: '/Users/u/www/mi-app-hotfix',
      head: 'e5e5e5e',
      rama: 'hotfix/factura',
      ultimaActividad: ahora - 3 * 3600_000,
      kb: 77_000
    },
    {
      ...base,
      ruta: '/Users/u/orca/workspaces/mi-app/tarea',
      head: 'f6f6f6f',
      rama: 'u/tarea',
      ultimaActividad: ahora - 20 * UN_DIA,
      kb: 120_000
    }
  ]
}

export function fotoDePrueba(): Foto {
  const foto = revisarFixture(memoriaConSesionMuerta(), { infos: infosDePrueba() }).foto
  return agregarWorktrees(foto, lecturasDePrueba(), AHORA, DIAS_INACTIVO)
}
