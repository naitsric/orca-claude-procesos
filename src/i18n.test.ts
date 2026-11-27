// Los idiomas: cuál se elige, que el español sale completo (motivos, confirmaciones, panel, barra) y
// que el panel pinta en el idioma de la foto. El resto de las pruebas corre en inglés, el de base.
import { assert, mockHost, mount, mountWorker, test } from 'orca/testing'
import { confirmarSesion } from './confirmar'
import { fotoDePrueba, HOME, AHORA, infosDePrueba, memoriaConSesionMuerta, revisarFixture } from './fixtures'
import { memoria, porcentaje } from './formato'
import { idiomaDeLocale, resolverIdioma, usarIdioma, type Idioma } from './i18n'
import * as panel from './panel'
import * as main from './worker'
import type { Foto } from './tipos'

/** Corre `fn` en `idioma` y deja el inglés después, pase lo que pase. */
async function en<T>(idioma: Idioma, fn: () => T | Promise<T>): Promise<T> {
  usarIdioma(idioma)
  try {
    return await fn()
  } finally {
    usarIdioma('en')
  }
}

test('elige el idioma de Orca si lo tiene; si no, inglés', () => {
  assert.equal(idiomaDeLocale('es'), 'es')
  assert.equal(idiomaDeLocale('es-CO'), 'es')
  assert.equal(idiomaDeLocale('es_419'), 'es')
  assert.equal(idiomaDeLocale('en-GB'), 'en')
  assert.equal(idiomaDeLocale('fr'), 'en', 'sin francés, inglés')
  assert.equal(idiomaDeLocale(''), 'en')
  assert.equal(idiomaDeLocale(undefined), 'en')
  assert.equal(resolverIdioma('auto', 'es-CO'), 'es')
  assert.equal(resolverIdioma(undefined, 'es-CO'), 'es', 'sin ajuste, como auto')
  assert.equal(resolverIdioma('en', 'es-CO'), 'en', 'el ajuste manda')
  assert.equal(resolverIdioma('es', 'ja'), 'es')
  assert.equal(resolverIdioma('auto', ''), 'en', 'si ningún panel ha dicho el idioma de Orca')
})

test('los números van con el separador de cada idioma', async () => {
  assert.equal(memoria(1.5 * 1024 * 1024), '1.5 GB')
  assert.equal(porcentaje(25.4), '25%')
  await en('es', () => {
    assert.equal(memoria(1.5 * 1024 * 1024), '1,5 GB')
    assert.equal(porcentaje(25.4), '25 %')
    assert.equal(porcentaje(3.25, 1), '3,3 %')
  })
})

test('los motivos salen en español y la foto dice en qué idioma vienen', async () => {
  const { foto } = await en('es', () => revisarFixture(memoriaConSesionMuerta(), { infos: infosDePrueba() }))
  assert.equal(foto.idioma, 'es')
  const s = foto.sesiones[0]
  assert.match(s.motivo, /^Inactiva desde hace 20 h\. Si ya no la usas, ciérrala/)
  assert.match(s.motivo, /Se retoma con claude --resume 0f3c2a9e/)
  const grafana = foto.huerfanos.find((h) => h.pid === 5001)!
  assert.match(grafana.motivo, /^Su sesión de Claude en old terminó hace 1 h y este proceso siguió vivo\./)
  assert.match(foto.sesiones[0].procesos.find((p) => p.pid === 9220)!.motivo, /Escucha en :5173\./)
  assert.equal(revisarFixture(memoriaConSesionMuerta()).foto.idioma, 'en', 'y de vuelta en inglés')
})

test('las confirmaciones en español', async () => {
  const f = await en('es', () => fotoDePrueba())
  const p = await en('es', () => confirmarSesion(f.sesiones[0], HOME, AHORA))
  assert.equal(p.titulo, '¿Cerrar la sesión «mi-app-c7»?')
  assert.equal(p.encabezado.startsWith('Se cierran 7 procesos'), true)
  assert.ok(p.items.includes('3 servidores MCP · 49 MB'), p.items.join(' | '))
  assert.equal(p.cancelar, 'Mantenerla abierta')
})

function hostCon(foto: Foto, locales: (string | undefined)[] = []) {
  return mockHost({
    requests: {
      'procesos.foto': (input) => {
        locales.push(input?.locale)
        return foto
      }
    }
  })
}

test('el panel pinta en el idioma de la foto y le cuenta al worker el de Orca', async () => {
  const fotoEn = fotoDePrueba()
  const fotoEs = await en('es', () => fotoDePrueba())
  const locales: (string | undefined)[] = []
  try {
    const view = await mount(panel, { host: hostCon(fotoEs, locales), locale: 'es-CO' })
    assert.deepEqual(locales, ['es-CO'], 'el worker no sabe en qué idioma está Orca')
    assert.ok(view.find({ text: 'Sesiones (1)' }))
    assert.ok(view.find({ text: 'Huérfanos (5)' }))
    assert.match(view.summary().join('\n'), /4 procesos huérfanos/)
    await view.press({ text: 'Cerrar todos' })
    assert.match(view.summary().join('\n'), /¿Cerrar 2 procesos huérfanos\?/)
    assert.deepEqual(view.errors, [])
    await view.unmount()

    // Orca en español pero el ajuste en inglés: la foto viene en inglés y el panel la sigue.
    const view2 = await mount(panel, { host: hostCon(fotoEn), locale: 'es-CO' })
    assert.ok(view2.find({ text: 'Sessions (1)' }))
    await view2.unmount()
  } finally {
    usarIdioma('en')
  }
})

/** Monta el worker, corre `fn` y lo apaga aunque `fn` falle: si no, sus temporizadores dejan
 *  colgada la prueba. */
async function conWorker(
  opciones: Parameters<typeof mockHost>[0],
  fn: (worker: Awaited<ReturnType<typeof mountWorker>>, host: ReturnType<typeof mockHost>) => Promise<void>
): Promise<void> {
  const host = mockHost(opciones)
  const worker = await mountWorker(main, { host, commands: ['revisar', 'cerrar-huerfanos', 'cerrar-worktrees'] })
  try {
    await fn(worker, host)
  } finally {
    await worker.deactivate()
    usarIdioma('en')
  }
}

const QUIETO = { intervaloSegundos: 300, avisarHuerfanos: false }

test('el worker sigue el idioma que le cuenta un panel y lo recuerda', async () => {
  await conWorker({ settings: { ...QUIETO, idioma: 'auto' } }, async (worker, host) => {
    const foto = await worker.request('procesos.foto', { locale: 'es-CO' })
    assert.equal(foto.idioma, 'es')
    assert.equal(host.data().storage.localeOrca, 'es-CO', 'para la barra de la próxima vez, antes de abrir un panel')
    const barra = host.callsOf('statusBar.update') as readonly { tooltip: string }[]
    assert.match(barra[barra.length - 1].tooltip, /Clic: revisar ahora/)
    assert.match(String(await worker.command('revisar')), /sesi(ón|ones) de Claude/)
  })
})

test('el ajuste de idioma manda sobre el de Orca', async () => {
  await conWorker({ settings: { ...QUIETO, idioma: 'en' }, storage: { localeOrca: 'es-CO' } }, async (worker) => {
    assert.equal((await worker.request('procesos.foto', { locale: 'es-CO' })).idioma, 'en')
  })
})

test('sin un panel abierto, el worker usa el último idioma que le contaron', async () => {
  await conWorker({ settings: QUIETO, storage: { localeOrca: 'es' } }, async (worker) => {
    assert.equal((await worker.request('procesos.foto')).idioma, 'es')
  })
  await conWorker({ settings: QUIETO }, async (worker) => {
    assert.equal((await worker.request('procesos.foto')).idioma, 'en', 'y si nunca se lo contaron, inglés')
  })
})
