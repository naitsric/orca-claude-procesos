// Linux: el ps de procps, los nombres cortados a 15 caracteres, /proc en vez de lsof y los
// huérfanos que adopta `systemd --user` en vez del pid 1.
import { assert, test } from 'orca/testing'
import { AHORA } from './fixtures'
import {
  agrupar,
  armarFoto,
  commDeLinux,
  cpuReciente,
  cpuSegDeStat,
  escuchasDeProcNet,
  memoriaVacia,
  nombreDe,
  parsearPs,
  puertosDeSockets,
  type CpuLeida,
  type Memoria
} from './procesos'

const UID = 1000
const HOME = '/home/u'

// - una sesión en GNOME Terminal (2300) con dos MCP: uno con título de npm y uno de python;
// - un vite (3001) de una sesión que murió (3000), que adoptó systemd --user;
// - una sesión (3500) cuya terminal se cerró y también adoptó systemd --user;
// - una app del escritorio (4000) que cuelga de systemd --user y no es de Claude.
const PS = [
  '    1     0     1     0 ?        2-00:00:00  12000   0.0 00:00:09 /sbin/init splash',
  ' 1200     1  1200  1000 ?          22:00:00  11000   0.0 00:00:01 /usr/lib/systemd/systemd --user',
  ' 2100  1200  2100  1000 ?          21:00:00  60000   0.1 00:00:30 /usr/libexec/gnome-terminal-server',
  ' 2200  2100  2200  1000 pts/0      20:00:00   5000   0.0 00:00:00 bash',
  ' 2300  2200  2300  1000 pts/0       2:00:00 400000  25.0 00:30:00 claude --resume 9a1b',
  ' 2310  2300  2300  1000 pts/0       1:59:59  60000   0.0 00:00:04 npm exec @playwright/mcp@latest',
  ' 2320  2300  2300  1000 pts/0       1:59:58  30000   0.0 00:00:01 /usr/bin/python3 -m mcp_server_git',
  ' 3001  1200  3000  1000 ?             50:00  52000   0.0 00:00:02 node /home/u/app/node_modules/.bin/vite',
  ' 3500  1200  3500  1000 ?           3:00:00 380000   0.0 00:10:00 /home/u/.local/bin/claude',
  ' 4000  1200  4000  1000 ?           5:00:00  20000   0.0 00:00:00 /usr/bin/python3 /usr/share/system-config-printer/applet.py'
].join('\n')

const COMM = [
  '    1 systemd',
  ' 1200 systemd',
  ' 2100 gnome-terminal-',
  ' 2200 bash',
  ' 2300 claude',
  ' 2310 npm exec @playw',
  ' 2320 python3',
  ' 3001 node',
  ' 3500 claude',
  ' 4000 python3'
].join('\n')

function memoriaConSesionMuerta(): Memoria {
  const m = memoriaVacia()
  const inicio = AHORA - 2 * 3600_000
  m.sesiones['3000@1'] = { pid: 3000, inicio, pgid: 3000, cwd: '/home/u/old', nombre: 'old-app', vista: AHORA - 600_000, termino: null }
  m.grupos['3000'] = { sesion: '3000@1', inicio }
  return m
}

test('lee el ps de procps: tty con pts y CPU acumulada en segundos enteros', () => {
  const filas = parsearPs(PS, COMM, AHORA, 'linux')
  assert.equal(filas.length, 10)
  const claude = filas.find((f) => f.pid === 2300)!
  assert.equal(claude.tty, 'pts/0')
  assert.equal(claude.cpuSeg, 1800)
  assert.equal(claude.inicio, AHORA - 2 * 3600_000)
  assert.equal(claude.comm, 'claude')
})

test('completa el comm cortado de Linux con la ruta o el título', () => {
  assert.equal(commDeLinux('claude', 'claude --resume x'), 'claude')
  assert.equal(commDeLinux('python3', '/usr/bin/python3 -m x'), '/usr/bin/python3')
  assert.equal(commDeLinux('npm exec @playw', 'npm exec @playwright/mcp@latest'), 'npm exec @playwright/mcp@latest')
  assert.equal(commDeLinux('gnome-terminal-', '/usr/libexec/gnome-terminal-server'), '/usr/libexec/gnome-terminal-server')
  assert.equal(commDeLinux('node', 'npm exec foo'), 'node', 'el título cambió el comando pero no el nombre')

  const [npm, py] = parsearPs(PS, COMM, AHORA, 'linux').filter((f) => f.pid === 2310 || f.pid === 2320)
  assert.equal(nombreDe(npm, 'mcp'), 'npm exec @playwright/mcp@latest')
  assert.equal(nombreDe(py, 'mcp'), 'python3 -m mcp_server_git')
})

test('agrupa la sesión de GNOME Terminal con sus MCP', () => {
  const memoria = memoriaConSesionMuerta()
  const a = agrupar(parsearPs(PS, COMM, AHORA, 'linux'), memoria, UID)
  const { foto } = armarFoto(a, new Map(), new Map(), memoria, { ahora: AHORA, horasSesionLarga: 12, home: HOME })
  const s = foto.sesiones.find((x) => x.pid === 2300)!
  assert.equal(s.anfitrion, 'GNOME Terminal')
  assert.equal(s.veredicto, 'dejar')
  assert.deepEqual(s.procesos.map((p) => [p.pid, p.rol]), [[2310, 'mcp'], [2320, 'mcp']])
})

test('un shell zombi no se muestra pero ata a la sesión lo que dejó corriendo', () => {
  // El shell de Bash (2330, su propio grupo) terminó y su padre aún no lo recoge; su servidor
  // ya lo adoptó systemd --user.
  const zombi = ' 2330  2300  2330  1000 ?             00:05      0   0.0 00:00:00 [bash] <defunct>'
  const server = ' 2340  1200  2330  1000 ?             00:05  40000   0.0 00:00:00 node /home/u/app/server.js'
  const revisar = (memoria: Memoria) => {
    const filas = parsearPs(`${PS}\n${zombi}\n${server}`, `${COMM}\n 2330 bash\n 2340 node`, AHORA, 'linux')
    return armarFoto(agrupar(filas, memoria, UID), new Map(), new Map(), memoria, { ahora: AHORA, horasSesionLarga: 12, home: HOME })
  }
  const primera = revisar(memoriaConSesionMuerta())
  const s = primera.foto.sesiones.find((x) => x.pid === 2300)!
  assert.ok(!s.procesos.some((p) => p.pid === 2330), 'el zombi no aparece')
  assert.ok(!primera.foto.huerfanos.some((h) => h.pid === 2330))
  assert.ok(primera.memoria.grupos['2330'], 'pero su grupo queda en la memoria')

  const segunda = revisar(primera.memoria).foto.sesiones.find((x) => x.pid === 2300)!
  assert.ok(segunda.procesos.some((p) => p.pid === 2340 && p.desacoplado), 'y con eso el servidor sigue con la sesión')
})

test('systemd --user adopta huérfanos como launchd', () => {
  const memoria = memoriaConSesionMuerta()
  const a = agrupar(parsearPs(PS, COMM, AHORA, 'linux'), memoria, UID)
  assert.ok(a.adoptivos.has(1200))
  const { foto } = armarFoto(a, new Map([[3001, [5173]]]), new Map(), memoria, {
    ahora: AHORA,
    horasSesionLarga: 12,
    home: HOME
  })
  assert.deepEqual(foto.huerfanos.map((h) => h.pid), [3001], 'ni systemd ni la app del escritorio son huérfanos')
  const vite = foto.huerfanos[0]
  assert.equal(vite.certeza, 'segura')
  assert.equal(vite.veredicto, 'cerrar')
  assert.equal(vite.origen?.pid, 3000)
  assert.match(vite.motivo, /«old-app» terminó.*:5173/)

  const sola = foto.sesiones.find((x) => x.pid === 3500)!
  assert.equal(sola.veredicto, 'revisar')
  assert.match(sola.motivo, /quedó sola/)
  assert.equal(sola.anfitrion, 'Sin terminal')
})

test('lee la CPU de /proc/<pid>/stat aunque el nombre tenga espacios y paréntesis', () => {
  const resto = 'S 2300 2300 2200 34816 2300 4194304 12345 0 12 0 345 67 0 0 20 0 11 0 123456 1234567 15000'
  assert.equal(cpuSegDeStat(`2310 (npm exec @playw) ${resto}`), 4.12)
  assert.equal(cpuSegDeStat(`2311 (a) b) ${resto}`, 250), 1.648)
  assert.equal(cpuSegDeStat('basura'), null)
})

test('la CPU de Linux es la reciente, no el promedio de toda la vida', () => {
  const filas = parsearPs(PS, COMM, AHORA, 'linux')
  const claude = filas.find((f) => f.pid === 2300)!
  const mcp = filas.find((f) => f.pid === 2310)!
  const previa: CpuLeida = new Map([
    [2300, { inicio: claude.inicio, cpuSeg: claude.cpuSeg - 2.5, t: AHORA - 5000, cpu: 25 }],
    [2310, { inicio: mcp.inicio, cpuSeg: mcp.cpuSeg - 0.1, t: AHORA - 1000, cpu: 7 }]
  ])
  const nueva = cpuReciente(filas, previa, AHORA)
  assert.equal(claude.cpu, 50, '2,5 s de CPU en 5 s')
  assert.equal(mcp.cpu, 7, 'con 1 s no se mide: se queda el valor anterior')
  assert.equal(nueva.get(2310)!.t, AHORA - 1000, 'y la referencia vieja')
  assert.equal(filas.find((f) => f.pid === 3500)!.cpu, 0, 'sin lectura anterior, la de ps')
})

test('saca los puertos en escucha de /proc/net y los descriptores de cada pid', () => {
  const cabecera = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
  const tcp = [
    cabecera,
    '   0: 0100007F:1435 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55501 1 0000000000000000 100 0 0 10 0',
    '   1: 0100007F:A5B2 0100007F:1435 01 00000000:00000000 00:00000000 00000000  1000        0 55600 1 0000000000000000 20 4 30 10 -1'
  ].join('\n')
  const tcp6 = [
    cabecera,
    '   0: 00000000000000000000000000000000:0BB9 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 55777 1 0000000000000000 100 0 0 10 0'
  ].join('\n')
  const escuchas = escuchasDeProcNet(tcp, tcp6)
  assert.deepEqual([...escuchas], [['55501', 5173], ['55777', 3001]], 'la conexión establecida no cuenta')
  const fds = new Map<number, string[]>([
    [3001, ['/dev/null', 'socket:[55501]', 'socket:[55600]', 'pipe:[1]']],
    [2310, ['socket:[55777]']],
    [2320, ['anon_inode:[eventpoll]']]
  ])
  assert.deepEqual([...puertosDeSockets(fds, escuchas)], [[3001, [5173]], [2310, [3001]]])
})
