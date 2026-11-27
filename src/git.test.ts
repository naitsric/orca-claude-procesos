// Lee y cierra worktrees de un repositorio de verdad, armado en una carpeta temporal con el git
// de esta máquina. Es la parte que borra carpetas: aquí se prueba que solo borra lo que debe.
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { assert, test } from 'orca/testing'
import { cerrarWorktrees, leerWorktrees, medirWorktrees } from './git'
import type { Worktree } from './tipos'
import { evaluarWorktrees, objetivoDe, type LecturaWorktree } from './worktrees'

const UN_DIA = 24 * 3600_000

function git(dir: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', dir, '-c', 'user.name=prueba', '-c', 'user.email=prueba@example.com', '-c', 'commit.gpgsign=false', ...args],
      { env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => (error ? reject(new Error(`git ${args.join(' ')}: ${stderr}`)) : resolve(stdout))
    )
  })
}

const existe = (ruta: string): Promise<boolean> => access(ruta).then(() => true, () => false)

/** Un repositorio `mi-app` con cuatro worktrees: limpio, con un archivo sin seguir, bloqueado por
 *  un subagente cuya sesión no existe, y con HEAD suelto y un commit que no está en ninguna rama. */
async function conRepo(fn: (repo: string, dir: string) => Promise<void>): Promise<void> {
  const dir = await realpath(await mkdtemp(`${tmpdir()}/claude-procesos-`))
  const configPrevia = process.env.CLAUDE_CONFIG_DIR
  // Sin esto leería el ~/.claude.json de quien corre la prueba y buscaría en sus repositorios.
  process.env.CLAUDE_CONFIG_DIR = `${dir}/config`
  try {
    const repo = `${dir}/mi-app`
    await mkdir(`${repo}/src`, { recursive: true })
    await git(repo, 'init', '-q', '-b', 'main')
    await writeFile(`${repo}/src/a.txt`, 'a\n')
    await git(repo, 'add', '.')
    await git(repo, 'commit', '-q', '-m', 'inicio')
    await git(repo, 'worktree', 'add', '-q', '.claude/worktrees/limpio', '-b', 'worktree-limpio')
    await git(repo, 'worktree', 'add', '-q', '.claude/worktrees/sucio', '-b', 'worktree-sucio')
    await writeFile(`${repo}/.claude/worktrees/sucio/sin guardar.txt`, 'trabajo a medias\n')
    await git(repo, 'worktree', 'add', '-q', '.claude/worktrees/agent-x1', '-b', 'feat/agente')
    await git(repo, 'worktree', 'lock', '--reason', 'claude agent agent-x1 (pid 999999 start Wed Sep 30 16:19:24 2026)', '.claude/worktrees/agent-x1')
    await git(repo, 'worktree', 'add', '-q', '--detach', `${dir}/suelto`)
    await writeFile(`${dir}/suelto/b.txt`, 'b\n')
    await git(`${dir}/suelto`, 'add', '.')
    await git(`${dir}/suelto`, 'commit', '-q', '-m', 'suelto')
    await fn(repo, dir)
  } finally {
    if (configPrevia === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = configPrevia
    await rm(dir, { recursive: true, force: true })
  }
}

/** Evaluados como si hubiera pasado un mes sin que nadie los tocara, sin sesiones vivas. */
function unMesDespues(lecturas: readonly LecturaWorktree[]): Worktree[] {
  return evaluarWorktrees(lecturas, { sesiones: [], huerfanos: [] }, { ahora: Date.now() + 30 * UN_DIA, diasInactivo: 7, home: '/nadie' })
}

const porNombre = (lista: readonly Worktree[], nombre: string): Worktree => {
  const w = lista.find((x) => x.nombre === nombre)
  assert.ok(w, `falta el worktree ${nombre}`)
  return w
}

test('lee los worktrees de un repositorio de verdad', async () => {
  await conRepo(async (repo, dir) => {
    const lecturas = await leerWorktrees([{ cwd: repo }])
    assert.deepEqual(
      lecturas.map((l) => l.ruta).sort(),
      [`${repo}/.claude/worktrees/agent-x1`, `${repo}/.claude/worktrees/limpio`, `${repo}/.claude/worktrees/sucio`, `${dir}/suelto`].sort(),
      'los cuatro enlazados; la carpeta principal no'
    )
    assert.ok(lecturas.every((l) => l.repo === repo && !l.error && !l.falta))
    const de = (nombre: string): LecturaWorktree => lecturas.find((l) => l.ruta.endsWith(`/${nombre}`))!
    assert.equal(de('limpio').rama, 'worktree-limpio')
    assert.equal(de('limpio').cambios + de('limpio').sinSeguir, 0)
    assert.equal(de('sucio').sinSeguir, 1)
    assert.match(de('agent-x1').bloqueo ?? '', /^claude agent agent-x1/)
    assert.equal(de('suelto').rama, null)
    assert.equal(de('suelto').commitsSueltos, 1)
    for (const l of lecturas) {
      assert.ok(l.ultimaActividad !== null && Math.abs(Date.now() - l.ultimaActividad) < 60_000, 'se acaban de crear')
    }

    // Desde una subcarpeta o desde uno de sus worktrees se llega al mismo repositorio, una vez.
    const desdeAdentro = await leerWorktrees([{ cwd: `${repo}/src` }, { cwd: `${repo}/.claude/worktrees/limpio` }])
    assert.equal(desdeAdentro.length, 4)
    // Y desde la carpeta de arriba, que no es un repositorio, por el `.claude/worktrees` de adentro.
    assert.equal((await leerWorktrees([{ cwd: dir }])).length, 4)
    assert.deepEqual(await leerWorktrees([{ cwd: `${dir}/no-existe` }]), [])

    assert.ok(await medirWorktrees(lecturas))
    assert.ok(lecturas.every((l) => typeof l.kb === 'number' && l.kb > 0), 'du los midió')

    const evaluados = unMesDespues(lecturas)
    assert.equal(porNombre(evaluados, 'limpio').veredicto, 'cerrar')
    assert.equal(porNombre(evaluados, 'agent-x1').veredicto, 'cerrar')
    assert.equal(porNombre(evaluados, 'sucio').veredicto, 'revisar')
    assert.equal(porNombre(evaluados, 'suelto').veredicto, 'revisar')
  })
})

test('cierra solo lo que sigue como se vio y deja las ramas', async () => {
  await conRepo(async (repo, dir) => {
    const evaluados = unMesDespues(await leerWorktrees([{ cwd: repo }]))
    const limpio = porNombre(evaluados, 'limpio')
    const sucio = porNombre(evaluados, 'sucio')
    const agente = porNombre(evaluados, 'agent-x1')

    const resultados = await cerrarWorktrees(
      [
        objetivoDe(limpio),
        objetivoDe(limpio),
        objetivoDe(agente),
        // Como si el panel lo hubiera visto limpio: los cambios aparecieron después.
        { ...objetivoDe(sucio), conCambios: false },
        { ruta: repo, head: limpio.head, conCambios: true },
        { ruta: `${dir}/suelto`, head: 'otro-commit', conCambios: true }
      ],
      evaluados
    )
    assert.deepEqual(
      resultados.map((r) => [r.nombre, r.resultado]),
      [
        ['limpio', 'cerrado'],
        ['agent-x1', 'cerrado'],
        ['sucio', 'rechazado'],
        ['mi-app', 'rechazado'],
        ['suelto', 'rechazado']
      ]
    )
    assert.ok(!(await existe(limpio.ruta)))
    assert.ok(!(await existe(agente.ruta)), 'el bloqueo de un subagente sin sesión no lo protege')
    assert.ok(await existe(`${sucio.ruta}/sin guardar.txt`), 'el trabajo sin guardar sigue ahí')
    assert.ok(await existe(`${repo}/src/a.txt`), 'la carpeta principal nunca se toca')
    assert.ok(await existe(`${dir}/suelto/b.txt`))
    const ramas = await git(repo, 'branch', '--list')
    assert.match(ramas, /worktree-limpio/, 'la rama se queda')
    assert.match(ramas, /feat\/agente/)

    // Con los cambios a la vista y confirmados, sí: es el --force de git.
    const despues = unMesDespues(await leerWorktrees([{ cwd: repo }]))
    assert.deepEqual(despues.map((w) => w.nombre).sort(), ['sucio', 'suelto'])
    const forzado = await cerrarWorktrees([objetivoDe(porNombre(despues, 'sucio'))], despues)
    assert.deepEqual(forzado.map((r) => r.resultado), ['cerrado'])
    assert.ok(!(await existe(sucio.ruta)))
  })
})

test('si git no puede quitarlo lo dice y lo deja bloqueado como estaba', async () => {
  await conRepo(async (repo) => {
    const evaluados = unMesDespues(await leerWorktrees([{ cwd: repo }]))
    const agente = porNombre(evaluados, 'agent-x1')
    // Aparece un archivo después de leerlo: git se niega a borrarlo sin --force.
    await writeFile(`${agente.ruta}/nuevo.txt`, 'x\n')
    const [r] = await cerrarWorktrees([objetivoDe(agente)], evaluados)
    assert.equal(r.resultado, 'error')
    assert.match(r.detalle ?? '', /Git couldn't remove it: .*modified or untracked files/)
    assert.ok(await existe(`${agente.ruta}/nuevo.txt`))
    assert.match(await git(repo, 'worktree', 'list', '--porcelain'), /locked claude agent agent-x1 \(pid 999999/)
  })
})
