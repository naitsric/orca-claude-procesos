// Qué worktrees se proponen cerrar y cuáles no se tocan, contra los inventados de fixtures.ts.
import { assert, test } from 'orca/testing'
import { confirmarWorktrees, resumirHecho, worktreesParaCerrar } from './confirmar'
import { AHORA, DIAS_INACTIVO, fotoDePrueba, HOME, lecturasDePrueba, REPO } from './fixtures'
import { usarIdioma } from './i18n'
import type { Worktree } from './tipos'
import {
  agenteDeBloqueo,
  agregarWorktrees,
  carpetaDeProyecto,
  carpetasCandidatas,
  evaluarWorktrees,
  objetivoDe,
  origenDe,
  parsearEstado,
  parsearListaWorktrees,
  validarCierre
} from './worktrees'

const CONFIG = { ahora: AHORA, diasInactivo: DIAS_INACTIVO, home: HOME }

function porNombre(lista: readonly Worktree[], nombre: string): Worktree {
  const w = lista.find((x) => x.nombre === nombre)
  assert.ok(w, `falta el worktree ${nombre}`)
  return w
}

test('lee git worktree list: la carpeta principal, ramas, HEAD suelto, bloqueos y carpetas borradas', () => {
  const salida = [
    'worktree /r/app',
    'HEAD 1111111',
    'branch refs/heads/main',
    '',
    'worktree /r/app/.claude/worktrees/agent-a1',
    'HEAD 2222222',
    'branch refs/heads/feat/x',
    'locked claude agent agent-a1 (pid 77 start Wed Sep 30 16:19:24 2026)',
    '',
    'worktree /r/app/.claude/worktrees/ido',
    'HEAD 3333333',
    'branch refs/heads/ido',
    'prunable gitdir file points to non-existent location',
    '',
    'worktree /r/suelto',
    'HEAD 4444444',
    'detached',
    '',
    'worktree /r/a mano',
    'HEAD 5555555',
    'branch refs/heads/mano',
    'locked',
    ''
  ].join('\n')
  const [principal, agente, ido, suelto, mano] = parsearListaWorktrees(salida)
  assert.equal(principal.ruta, '/r/app')
  assert.equal(principal.rama, 'main')
  assert.equal(agente.rama, 'feat/x')
  assert.equal(agente.bloqueo, 'claude agent agent-a1 (pid 77 start Wed Sep 30 16:19:24 2026)')
  assert.ok(ido.falta)
  assert.equal(suelto.rama, null)
  assert.equal(suelto.head, '4444444')
  assert.equal(mano.ruta, '/r/a mano', 'las rutas pueden tener espacios')
  assert.equal(mano.bloqueo, '', 'bloqueado sin motivo')
  assert.equal(principal.bloqueo, null)
})

test('lee git status: cambios, renombres, sin seguir y commits sin subir', () => {
  const salida = [
    '# branch.oid 1111111',
    '# branch.head feat/x',
    '# branch.upstream origin/feat/x',
    '# branch.ab +3 -1',
    '1 .M N... 100644 100644 100644 aaa bbb src/con espacio.ts',
    '2 R. N... 100644 100644 100644 aaa bbb R100 nuevo.ts',
    'viejo.ts',
    'u UU N... 100644 100644 100644 100644 aaa bbb ccc choque.ts',
    '? notas/',
    '? suelto.txt',
    ''
  ].join('\0')
  const e = parsearEstado(salida)
  assert.equal(e.sinSubir, 3)
  assert.equal(e.cambios, 3)
  assert.equal(e.sinSeguir, 2)
  assert.deepEqual(e.rutas, ['src/con espacio.ts', 'nuevo.ts', 'choque.ts', 'notas', 'suelto.txt'])

  const limpio = parsearEstado(['# branch.oid 1111111', '# branch.head worktree-x', ''].join('\0'))
  assert.deepEqual(limpio, { sinSubir: null, cambios: 0, sinSeguir: 0, rutas: [] })
})

test('reconoce de dónde salió cada worktree', () => {
  assert.equal(origenDe('/r/app/.claude/worktrees/feat+pagos', null), 'claude')
  assert.equal(origenDe('/r/app/.claude/worktrees/agent-a1', null), 'agente')
  assert.equal(origenDe('/r/otro-lado', 'claude agent agent-a1 (pid 77 start Wed Sep 30 16:19:24 2026)'), 'agente')
  assert.equal(origenDe('/Users/u/orca/workspaces/app/tarea', null), 'orca')
  assert.equal(origenDe('/r/app-hotfix', null), 'otro')
  assert.deepEqual(agenteDeBloqueo('claude agent agent-a1 (pid 77 start Wed Sep 30 16:19:24 2026)'), {
    id: 'agent-a1',
    pid: 77,
    inicio: Date.UTC(2026, 8, 30, 16, 19, 24)
  })
  assert.equal(agenteDeBloqueo('disco externo'), null)
  assert.equal(agenteDeBloqueo(null), null)
})

test('busca repositorios donde se abrió Claude y donde trabajan las sesiones', () => {
  const json = JSON.stringify({ projects: { '/Users/u/www/mi-app': {}, '/Users/u/www/': {}, relativo: {} } })
  assert.deepEqual(carpetasCandidatas(json, [{ cwd: '/Users/u/www/otra' }, { cwd: null }, { cwd: '/Users/u/www/mi-app' }]), [
    '/Users/u/www/mi-app',
    '/Users/u/www',
    '/Users/u/www/otra'
  ])
  assert.deepEqual(carpetasCandidatas('no es json', []), [])
  assert.deepEqual(carpetasCandidatas(null, [{ cwd: '/x' }]), ['/x'])
  assert.equal(carpetaDeProyecto('/Users/u/www/mi_app/.claude/worktrees/feat+pagos'), '-Users-u-www-mi-app--claude-worktrees-feat-pagos')
})

test('propone cerrar los inactivos sin nada que perder y deja los demás', () => {
  const f = fotoDePrueba()
  const pagos = porNombre(f.worktrees, 'feat+pagos')
  assert.equal(pagos.veredicto, 'cerrar')
  assert.equal(pagos.origen, 'claude')
  assert.match(pagos.motivo, /^No activity for 12 d\. Nothing to lose: no uncommitted changes, and the branch worktree-feat\+pagos stays with its 2 unpushed commits\.$/)

  const agente = porNombre(f.worktrees, 'agent-a1b2c3')
  assert.equal(agente.veredicto, 'cerrar', 'la sesión del subagente ya murió: su bloqueo no lo protege')
  assert.equal(agente.enUso, null)
  assert.ok(agente.cerrable)
  assert.match(agente.motivo, /A subagent left it behind\./)

  const login = porNombre(f.worktrees, 'fix+login')
  assert.equal(login.veredicto, 'revisar', 'inactivo pero con cambios: no se propone')
  assert.match(login.motivo, /3 uncommitted changes: closing it discards them\./)
  assert.ok(login.cerrable, 'se puede cerrar eligiéndolo, con su aviso')

  const vivo = porNombre(f.worktrees, 'agent-d4e5f6')
  assert.equal(vivo.veredicto, 'dejar')
  assert.ok(!vivo.cerrable, 'lo usa un subagente de una sesión viva')
  assert.deepEqual(vivo.enUso, { pid: 4129, nombre: 'mi-app-c7' })
  assert.equal(vivo.motivo, 'A subagent of the session “mi-app-c7” is working in it.')

  const hotfix = porNombre(f.worktrees, 'mi-app-hotfix')
  assert.equal(hotfix.veredicto, 'dejar')
  assert.equal(hotfix.origen, 'otro')
  assert.equal(hotfix.motivo, 'Active 3 h ago.')

  const orca = porNombre(f.worktrees, 'tarea')
  assert.equal(orca.veredicto, 'revisar')
  assert.ok(!orca.cerrable, 'los workspaces de Orca se cierran desde Orca')

  assert.deepEqual(
    f.worktrees.map((w) => w.nombre),
    ['agent-a1b2c3', 'feat+pagos', 'tarea', 'fix+login', 'mi-app-hotfix', 'agent-d4e5f6'],
    'primero los que se proponen cerrar, y entre iguales el más quieto'
  )
  assert.equal(f.totales.worktrees, 6)
  assert.equal(f.totales.worktreesCerrar, 2)
  assert.equal(f.totales.worktreesCerrarKb, 348_160 + 512_000)
  assert.deepEqual(worktreesParaCerrar(f).map((w) => w.nombre), ['agent-a1b2c3', 'feat+pagos'])
})

test('el umbral de inactividad es el del ajuste', () => {
  const sin = fotoDePrueba()
  const f = agregarWorktrees({ ...sin, worktrees: [] }, lecturasDePrueba(), AHORA, 20)
  assert.equal(porNombre(f.worktrees, 'feat+pagos').veredicto, 'dejar', '12 días no llegan a 20')
  assert.equal(porNombre(f.worktrees, 'agent-a1b2c3').veredicto, 'cerrar')
  assert.equal(f.totales.worktreesCerrar, 1)
})

test('una sesión que trabaja dentro del worktree lo deja en uso', () => {
  const f = fotoDePrueba()
  const ruta = `${REPO}/.claude/worktrees/feat+pagos`
  const dentro = { ...f, sesiones: [{ ...f.sesiones[0], cwd: `${ruta}/src` }] }
  const w = porNombre(evaluarWorktrees(lecturasDePrueba(), dentro, CONFIG), 'feat+pagos')
  assert.equal(w.veredicto, 'dejar')
  assert.ok(!w.cerrable)
  assert.equal(w.motivo, 'The session “mi-app-c7” is working in it.')
  // La sesión en la carpeta principal no cuenta: el worktree está más adentro.
  assert.ok(porNombre(f.worktrees, 'feat+pagos').cerrable)
})

test('casos que no se proponen: bloqueo a mano, huérfano adentro, HEAD suelto con commits, sin leer', () => {
  const f = fotoDePrueba()
  const [base] = lecturasDePrueba()
  const evaluar = (cambio: Partial<typeof base>, foto = f) => evaluarWorktrees([{ ...base, ...cambio }], foto, CONFIG)[0]

  const mano = evaluar({ bloqueo: 'disco externo' })
  assert.equal(mano.veredicto, 'dejar')
  assert.ok(!mano.cerrable)
  assert.match(mano.motivo, /Locked in Git \(“disco externo”\)/)

  const huerfano = { ...f.huerfanos.find((h) => h.nivel === 0)!, cwd: base.ruta }
  const conHuerfano = evaluar({}, { ...f, huerfanos: [huerfano] })
  assert.equal(conHuerfano.veredicto, 'revisar')
  assert.ok(!conHuerfano.cerrable)

  const suelto = evaluar({ rama: null, commitsSueltos: 2 })
  assert.equal(suelto.veredicto, 'revisar')
  assert.match(suelto.motivo, /Its last 2 commits are on no branch: closing it loses them\./)

  const roto = evaluar({ error: 'not a git repository' })
  assert.equal(roto.veredicto, 'revisar')
  assert.ok(!roto.cerrable)

  const ido = evaluar({ falta: true, ultimaActividad: null, kb: null })
  assert.equal(ido.veredicto, 'cerrar')
  assert.match(ido.motivo, /folder no longer exists/)
})

test('solo se cierra lo que sigue como se vio', () => {
  const f = fotoDePrueba()
  const pagos = porNombre(f.worktrees, 'feat+pagos')
  const login = porNombre(f.worktrees, 'fix+login')
  const vivo = porNombre(f.worktrees, 'agent-d4e5f6')

  assert.deepEqual(validarCierre(objetivoDe(pagos), f.worktrees), { worktree: pagos, forzar: false })
  assert.deepEqual(validarCierre(objetivoDe(login), f.worktrees), { worktree: login, forzar: true }, 'con cambios avisados: --force')

  const rechazo = (o: Parameters<typeof validarCierre>[0], lista = f.worktrees): string => {
    const v = validarCierre(o, lista)
    assert.ok('rechazo' in v)
    return v.rechazo
  }
  assert.match(rechazo({ ruta: REPO, head: 'x', conCambios: false }), /no longer shows up/, 'la carpeta principal nunca está')
  assert.match(rechazo({ ...objetivoDe(pagos), head: 'otro' }), /new commits/)
  assert.match(rechazo({ ruta: vivo.ruta, head: vivo.head, conCambios: true }), /is working in it/)
  // Limpio cuando se confirmó, con cambios al momento de cerrar: no se descartan sin avisar.
  const ahoraSucio = f.worktrees.map((w) => (w.ruta === pagos.ruta ? { ...w, sinSeguir: 1 } : w))
  assert.match(rechazo(objetivoDe(pagos), ahoraSucio), /uncommitted changes now/)
})

test('la confirmación dice qué se libera, qué se queda y qué se pierde', () => {
  const f = fotoDePrueba()
  const p = confirmarWorktrees('aviso-worktrees', worktreesParaCerrar(f), AHORA)!
  assert.equal(p.titulo, 'Close 2 worktrees?')
  assert.equal(p.tono, 'warning')
  assert.equal(p.encabezado, 'Closing (frees 840 MB):')
  assert.deepEqual(p.items, [
    'mi-app/agent-a1b2c3 · feat/exportar · no activity for 28 d · 500 MB',
    'mi-app/feat+pagos · worktree-feat+pagos · no activity for 12 d · 340 MB'
  ])
  assert.deepEqual(p.notas.map((n) => n.texto), [
    'Their branches and commits stay in the repository.',
    'The folders are deleted with everything inside, ignored files included (node_modules, .env).'
  ])
  assert.deepEqual(p.objetivos, [], 'no cierra procesos')
  assert.deepEqual(p.worktrees, [
    { ruta: `${REPO}/.claude/worktrees/agent-a1b2c3`, head: 'b2b2b2b', conCambios: false },
    { ruta: `${REPO}/.claude/worktrees/feat+pagos`, head: 'a1a1a1a', conCambios: false }
  ])

  const conCambios = confirmarWorktrees('worktrees', [porNombre(f.worktrees, 'fix+login'), porNombre(f.worktrees, 'mi-app-hotfix')], AHORA)!
  assert.equal(conCambios.tono, 'danger')
  assert.ok(conCambios.notas.some((n) => n.tono === 'danger' && n.texto === 'fix+login has uncommitted changes: they are discarded for good.'))
  assert.ok(conCambios.notas.some((n) => n.tono === 'warning' && /mi-app-hotfix had activity recently/.test(n.texto)))
  assert.equal(conCambios.worktrees![0].conCambios, true)

  // Lo que no se puede cerrar no entra aunque llegue marcado.
  assert.equal(confirmarWorktrees('worktrees', [porNombre(f.worktrees, 'tarea'), porNombre(f.worktrees, 'agent-d4e5f6')], AHORA), null)
})

test('el resultado dice cuáles no se cerraron y por qué', () => {
  const bien = resumirHecho({
    origen: 'worktrees',
    titulo: 'Closed 2 worktrees',
    lista: [],
    worktrees: [
      { ruta: '/a', nombre: 'a', resultado: 'cerrado' },
      { ruta: '/b', nombre: 'b', resultado: 'cerrado' }
    ]
  })
  assert.ok(bien.todoBien)
  assert.equal(bien.titulo, 'Closed 2 worktrees')

  const mal = resumirHecho({
    origen: 'worktrees',
    titulo: 'Closed 2 worktrees',
    lista: [],
    worktrees: [
      { ruta: '/a', nombre: 'a', resultado: 'cerrado' },
      { ruta: '/b', nombre: 'b', resultado: 'rechazado', detalle: 'It has uncommitted changes now. Check it again.' }
    ]
  })
  assert.ok(!mal.todoBien)
  assert.equal(mal.titulo, 'Closed 1 of 2 worktrees')
  assert.deepEqual(mal.lineas, ['b: It has uncommitted changes now. Check it again.'])
  assert.deepEqual(mal.vivos, [])
})

test('los motivos salen en español', () => {
  usarIdioma('es')
  try {
    const lista = evaluarWorktrees(lecturasDePrueba(), fotoDePrueba(), CONFIG)
    assert.equal(
      porNombre(lista, 'feat+pagos').motivo,
      'Sin actividad desde hace 12 d. No hay nada que perder: no tiene cambios sin confirmar y la rama worktree-feat+pagos se queda con 2 commits sin subir.'
    )
    assert.equal(porNombre(lista, 'agent-d4e5f6').motivo, 'Un subagente de la sesión «mi-app-c7» trabaja en él.')
    assert.match(porNombre(lista, 'fix+login').motivo, /Tiene 3 cambios sin confirmar: al cerrarlo se descartan\./)
  } finally {
    usarIdioma('en')
  }
})
