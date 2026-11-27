// Panel lateral: sesiones de Claude, sus procesos, los huérfanos y los worktrees que quedaron
// abiertos, con botones para cerrarlos.
// El worker (src/worker.ts) hace todo el trabajo; aquí solo se pinta la foto que publica.
//
// Cerrar algo pasa en el mismo lugar donde está el botón: la confirmación reemplaza a los botones
// (dentro de la tarjeta de la sesión, debajo de la tabla de huérfanos o de worktrees, o en el
// aviso de arriba), y
// el resultado queda ahí mismo hasta que se pulsa «Listo». Cada acción lleva un `origen` para eso.
import {
  atom,
  Button,
  Callout,
  Code,
  Collapsible,
  EmptyState,
  env,
  Heading,
  IconButton,
  KeyValue,
  plugin,
  read,
  RelativeTime,
  Row,
  set,
  Skeleton,
  Spinner,
  Stack,
  Switch,
  Tab,
  Table,
  Tabs,
  Text,
  update,
  type PanelContext,
  type TableColumn,
  type TableRow
} from 'orca'
import {
  confirmarDeSesion,
  confirmarForzar,
  confirmarHuerfanos,
  confirmarSesion,
  confirmarWorktrees,
  estadoCorto,
  huerfanosSeguros,
  nombreSesion,
  nombreWorktree,
  resumirHecho,
  tieneAviso,
  worktreesParaCerrar,
  type Hecho,
  type Pendiente
} from './confirmar'
import { abreviarRuta, carpeta, duracion, memoria, porcentaje, puertos } from './formato'
import { idiomaDeLocale, t, usarIdioma } from './i18n'
import type { Foto, Huerfano, Proceso, Sesion, Worktree } from './tipos'

const foto = atom<Foto | null>(null)
const falloPedido = atom<string | null>(null)
const pendiente = atom<Pendiente | null>(null)
/** El origen de la acción que se está ejecutando. */
const cerrando = atom<string | null>(null)
const hecho = atom<Hecho | null>(null)
/** Filas marcadas por tabla: `s<pid>` para cada sesión, y `huerfanos` y `worktrees` para sus pestañas. */
const seleccion = atom<Record<string, string[]>>({})
const abiertas = atom<Record<string, boolean>>({})
const pestana = atom('pestana', 'sesiones', { persist: 'plugin' })
const soloRevisar = atom('soloRevisar', false, { persist: 'plugin' })

/** Lo más que Orca deja esperar un pedido al worker. Borrar carpetas con node_modules tarda
 *  bastante más que mandar una señal. */
const PLAZO_WORKTREES_MS = 120_000

function mensaje(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Los textos van en el idioma de la foto, el mismo de los motivos que calculó el worker. */
function recibir(f: Foto): void {
  usarIdioma(f.idioma)
  set(foto, f)
}

async function refrescar(): Promise<void> {
  try {
    recibir(await plugin.request('procesos.foto', { locale: env.locale }, { timeoutMs: 60_000 }))
    set(falloPedido, null)
  } catch (error) {
    set(falloPedido, mensaje(error))
  }
}

async function ejecutar(p: Pendiente): Promise<void> {
  set(pendiente, null)
  set(cerrando, p.origen)
  try {
    if (p.worktrees) {
      const respuesta = await plugin.request('procesos.cerrarWorktrees', { objetivos: p.worktrees }, { timeoutMs: PLAZO_WORKTREES_MS })
      recibir(respuesta.foto)
      set(hecho, {
        origen: p.origen,
        titulo: p.hecho,
        lista: [],
        worktrees: respuesta.resultados,
        ...(respuesta.faltan ? { faltan: respuesta.faltan } : {})
      })
    } else {
      const respuesta = await plugin.request(
        'procesos.cerrar',
        { objetivos: p.objetivos, senal: p.senal, arbol: p.arbol },
        { timeoutMs: 60_000 }
      )
      recibir(respuesta.foto)
      set(hecho, { origen: p.origen, titulo: p.hecho, lista: respuesta.resultados })
    }
    set(seleccion, {})
  } catch (error) {
    // El worker sigue borrando aunque el pedido venza: su foto llega cuando termina.
    if (p.worktrees && (error as { code?: string }).code === 'timeout') {
      set(hecho, { origen: p.origen, titulo: p.hecho, lista: [], worktrees: [], faltan: p.worktrees.length })
    } else {
      set(hecho, { origen: p.origen, titulo: p.hecho, lista: [], error: mensaje(error) })
    }
  } finally {
    set(cerrando, null)
  }
}

/**
 * El comando «Claude Processes: close inactive worktrees» no cierra nada: deja un pedido, y este
 * panel pregunta por él en la pestaña Worktrees, con los inactivos marcados en la tabla. Si el
 * panel no estaba abierto, lo encuentra al abrirse. Como con el botón, nada se cierra sin
 * confirmar aquí.
 */
async function atenderComando(): Promise<void> {
  // Sin la primera foto no hay lista que mostrar: el pedido se toma cuando llegue.
  if (!read(foto)) return
  const { pedida } = await plugin.request('procesos.tomarConfirmacion').catch(() => ({ pedida: false }))
  // El comando publicó su foto antes de pedir: la de ahora trae los worktrees que él vio.
  const f = read(foto)
  if (!pedida || !f || f.error || read(cerrando) !== null) return
  const inactivos = worktreesParaCerrar(f)
  if (!inactivos.length) return
  set(pestana, 'worktrees')
  update(seleccion, (sel) => ({ ...sel, worktrees: inactivos.map((w) => w.ruta) }))
  pedir(confirmarWorktrees('worktrees', inactivos, f.tomadaEn))
}

export function setup(ctx: PanelContext): void {
  // Hasta la primera foto, el idioma de Orca.
  usarIdioma(idiomaDeLocale(env.locale))
  ctx.subscriptions.push(plugin.on('procesos.foto', recibir))
  ctx.subscriptions.push(plugin.on('procesos.confirmarWorktrees', () => void atenderComando()))
  // El final de un cierre largo: el resultado completo reemplaza al «sigo cerrando».
  ctx.subscriptions.push(
    plugin.on('procesos.worktreesCerrados', ({ resultados }) => {
      const h = read(hecho)
      if (h?.faltan) set(hecho, { origen: h.origen, titulo: h.titulo, lista: [], worktrees: resultados })
    })
  )
  void refrescar().then(atenderComando)
}

/** Muestra la confirmación (armada en ./confirmar) en el lugar de la acción. */
function pedir(p: Pendiente | null): void {
  if (!p) return
  set(hecho, null)
  set(pendiente, p)
}


// ---------------------------------------------------------------------------------------------
// La confirmación, el progreso y el resultado, en el lugar de la acción

/** Si hay algo que mostrar en `origen` (confirmación, cierre en curso o resultado). */
function activo(origen: string): boolean {
  return read(pendiente)?.origen === origen || read(cerrando) === origen || read(hecho)?.origen === origen
}

function Confirmacion(props: { p: Pendiente }) {
  const { p } = props
  return (
    <Callout tone={p.tono} title={p.titulo} icon="warning">
      <Stack gap="sm">
        <Stack gap="xs">
          <Text size="sm" weight="medium">
            {p.encabezado}
          </Text>
          {p.items.map((i) => (
            <Text size="sm">• {i}</Text>
          ))}
        </Stack>
        {p.notas.map((n) => (
          <Text size="sm" tone={n.tono}>
            {n.texto}
          </Text>
        ))}
        <Row gap="xs" wrap>
          <Button size="sm" tone="danger" icon="stop" onPress={() => ejecutar(p)}>
            {p.boton}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(pendiente, null)}>
            {p.cancelar}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function Resultado(props: { h: Hecho; f: Foto | null }) {
  const { h } = props
  const r = resumirHecho(h)
  return (
    <Callout tone={r.todoBien ? 'success' : 'warning'} title={r.titulo} icon={r.todoBien ? 'check' : 'warning'}>
      <Stack gap="xs">
        {r.lineas.map((l) => (
          <Text size="sm" muted={r.todoBien}>
            {l}
          </Text>
        ))}
        <Row gap="xs">
          {r.vivos.length ? (
            <Button size="sm" tone="danger" onPress={() => pedir(confirmarForzar(h.origen, r.vivos, props.f))}>
              {t().panel.forzar}
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onPress={() => set(hecho, null)}>
            {t().panel.listo}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

function Accion(props: { origen: string }) {
  const p = read(pendiente)
  if (p?.origen === props.origen) return <Confirmacion p={p} />
  if (read(cerrando) === props.origen) {
    return (
      <Row gap="xs" align="center">
        <Spinner label={t().panel.cerrando} labelHidden />
        <Text size="sm" muted>
          {t().panel.cerrandoPuntos}
        </Text>
      </Row>
    )
  }
  const h = read(hecho)
  if (h?.origen === props.origen) return <Resultado h={h} f={read(foto)} />
  return null
}

// ---------------------------------------------------------------------------------------------
// Piezas

function columnas(): readonly TableColumn[] {
  const c = t().panel.columnas
  return [
    { key: 'proceso', label: c.proceso, minWidth: 'sm' },
    { key: 'estado', label: c.estado, width: 'xs' },
    { key: 'mem', label: c.mem, width: 'xs', align: 'end' },
    { key: 'edad', label: c.edad, width: 'xs', align: 'end', hideBelow: 'sm' }
  ]
}

function fila(p: Proceso | Huerfano): TableRow {
  const sangria = p.nivel > 0 ? `${'  '.repeat(p.nivel - 1)}└ ` : ''
  const enPuerto = p.puertos.length ? ` ${puertos(p.puertos)}` : ''
  const estado = 'certeza' in p && p.certeza === 'probable' ? t().panel.revisarDudoso : t().veredictos[p.veredicto]
  return {
    key: String(p.pid),
    cells: {
      proceso: `${sangria}${p.nombre}${enPuerto}`,
      estado,
      mem: memoria(p.rssKb),
      edad: { type: 'relative', at: p.inicio, format: 'duration' }
    }
  }
}

function Detalles(props: { lista: readonly (Proceso | Huerfano)[]; home: string }) {
  if (!props.lista.length) return null
  return (
    <Stack gap="sm">
      {props.lista.slice(0, 3).map((p) => (
        <Stack gap="xs">
          <Text size="sm" weight="medium">
            {p.nombre} <Text muted size="xs">pid {p.pid}</Text>
          </Text>
          <Text size="sm" tone={p.veredicto === 'cerrar' ? 'danger' : p.veredicto === 'revisar' ? 'warning' : undefined}>
            {p.motivo}
          </Text>
          {'cwd' in p && p.cwd ? (
            <Text muted size="xs">
              {t().panel.carpeta}: {abreviarRuta(p.cwd, props.home)}
            </Text>
          ) : null}
          <Code block>{p.comando}</Code>
        </Stack>
      ))}
      {props.lista.length > 3 ? <Text muted size="xs">{t().panel.yMas(props.lista.length - 3)}</Text> : null}
    </Stack>
  )
}

function TarjetaSesion(props: { sesion: Sesion; home: string; filtrar: boolean; ocupado: boolean }) {
  const { sesion: s, home, filtrar, ocupado } = props
  const clave = `s${s.pid}`
  const visibles = filtrar ? s.procesos.filter((p) => p.veredicto !== 'dejar') : s.procesos
  const marcados = new Set(read(seleccion)[clave] ?? [])
  const elegidos = s.procesos.filter((p) => marcados.has(String(p.pid)))
  const ahora = read(foto)?.tomadaEn ?? Date.now()
  const aviso = tieneAviso(s)
  const sobran = s.procesos.filter((p) => p.veredicto === 'cerrar')
  // Con una confirmación pendiente la tarjeta se queda abierta: es donde está la pregunta.
  const abierta = (read(abiertas)[clave] ?? false) || activo(clave)
  const tx = t()
  return (
    <Collapsible
      title={`${aviso ? '⚠ ' : ''}${nombreSesion(s, home)}`}
      description={[
        s.nombre ? carpeta(s.cwd, home) : null,
        estadoCorto(s, ahora),
        memoria(s.rssTotalKb),
        tx.procesos(s.procesos.length)
      ]
        .filter(Boolean)
        .join(' · ')}
      open={abierta}
      onChange={(open) => update(abiertas, (a) => ({ ...a, [clave]: open }))}
    >
      <Stack gap="sm">
        <Text size="sm" tone={s.veredicto === 'revisar' ? 'warning' : undefined}>
          {s.motivo}
        </Text>
        <KeyValue
          items={[
            { label: 'pid', value: s.pid, code: true },
            { label: tx.panel.carpeta, value: abreviarRuta(s.cwd, home), code: true },
            { label: tx.panel.terminal, value: `${s.anfitrion} (${s.tty})` },
            { label: tx.panel.abierta, value: tx.panel.hace(duracion(ahora - s.inicio)) },
            { label: 'CPU', value: porcentaje(s.cpu, 1) },
            ...(s.sessionId ? [{ label: '--resume', value: s.sessionId, code: true }] : [])
          ]}
        />
        {visibles.length ? (
          <Table
            label={tx.panel.procesosDeSesion(s.pid)}
            columns={columnas()}
            rows={visibles.map(fila)}
            selectionMode="multiple"
            selected={[...marcados].filter((k) => visibles.some((p) => String(p.pid) === k))}
            onSelectionChange={({ keys }) => update(seleccion, (sel) => ({ ...sel, [clave]: keys }))}
            maxHeight="md"
          />
        ) : (
          <Text muted size="sm">
            {s.procesos.length ? tx.panel.todosBien : tx.panel.sinHijos}
          </Text>
        )}
        <Detalles lista={elegidos} home={home} />
        {activo(clave) ? (
          <Accion origen={clave} />
        ) : (
          <Row gap="xs" wrap>
            <Button
              size="sm"
              variant="outline"
              disabled={!elegidos.length || ocupado}
              onPress={() => pedir(confirmarDeSesion(s, elegidos, home))}
            >
              {tx.panel.cerrarSeleccionados(elegidos.length)}
            </Button>
            {sobran.length ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={ocupado}
                onPress={() => update(seleccion, (sel) => ({ ...sel, [clave]: sobran.map((p) => String(p.pid)) }))}
              >
                {tx.panel.marcarSobran}
              </Button>
            ) : null}
            <Button
              size="sm"
              tone="danger"
              variant="outline"
              icon="stop"
              disabled={ocupado}
              onPress={() => pedir(confirmarSesion(s, home, ahora))}
            >
              {tx.panel.cerrarSesion}
            </Button>
          </Row>
        )}
      </Stack>
    </Collapsible>
  )
}

function PestanaSesiones(props: { f: Foto; ocupado: boolean }) {
  const { f, ocupado } = props
  const filtrar = read(soloRevisar)
  const sesiones = filtrar
    ? f.sesiones.filter(tieneAviso)
    : f.sesiones
  // Una sesión cerrada desaparece de la lista; su resultado queda arriba de la lista.
  const h = read(hecho)
  const huerfano = h && h.origen.startsWith('s') && !f.sesiones.some((s) => `s${s.pid}` === h.origen) ? h.origen : null
  const tx = t().panel
  return (
    <Stack gap="sm">
      <Switch label={tx.soloRevisar} checked={filtrar} onChange={(v) => set(soloRevisar, v)} />
      {huerfano ? <Accion origen={huerfano} /> : null}
      {sesiones.length ? (
        sesiones.map((s) => <TarjetaSesion sesion={s} home={f.home} filtrar={filtrar} ocupado={ocupado} />)
      ) : (
        <EmptyState
          icon="check"
          title={f.sesiones.length ? tx.nadaQueRevisar : tx.sinSesiones}
          description={f.sesiones.length ? tx.todoEnUso : tx.ningunClaude}
        />
      )}
    </Stack>
  )
}

function PestanaHuerfanos(props: { f: Foto; ocupado: boolean }) {
  const { f, ocupado } = props
  const tx = t().panel
  if (!f.huerfanos.length) {
    return (
      <Stack gap="sm">
        <Accion origen="huerfanos" />
        <EmptyState icon="check" title={tx.sinHuerfanos} description={tx.ningunoSobrevivio} />
      </Stack>
    )
  }
  const marcados = new Set(read(seleccion).huerfanos ?? [])
  const elegidos = f.huerfanos.filter((h) => marcados.has(String(h.pid)))
  const seguros = huerfanosSeguros(f)
  return (
    <Stack gap="sm">
      <Text muted size="sm">
        {tx.explicaDudoso}
      </Text>
      <Table
        label={tx.huerfanosTabla}
        columns={columnas()}
        rows={f.huerfanos.map(fila)}
        selectionMode="multiple"
        selected={[...marcados].filter((k) => f.huerfanos.some((h) => String(h.pid) === k))}
        onSelectionChange={({ keys }) => update(seleccion, (sel) => ({ ...sel, huerfanos: keys }))}
        maxHeight="lg"
      />
      <Detalles lista={elegidos} home={f.home} />
      {activo('huerfanos') ? (
        <Accion origen="huerfanos" />
      ) : (
        <Row gap="xs" wrap>
          <Button
            size="sm"
            tone="danger"
            disabled={!elegidos.length || ocupado}
            onPress={() => pedir(confirmarHuerfanos('huerfanos', elegidos, f.huerfanos, f.home))}
          >
            {tx.cerrarSeleccionados(elegidos.length)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!seguros.length}
            onPress={() => update(seleccion, (sel) => ({ ...sel, huerfanos: seguros.map((h) => String(h.pid)) }))}
          >
            {tx.marcarSeguros}
          </Button>
        </Row>
      )}
    </Stack>
  )
}

function columnasWorktrees(): readonly TableColumn[] {
  const c = t().panel.columnasWorktrees
  return [
    { key: 'worktree', label: c.worktree, minWidth: 'sm' },
    { key: 'estado', label: c.estado, width: 'xs' },
    { key: 'disco', label: c.disco, width: 'xs', align: 'end' },
    { key: 'quieto', label: c.quieto, width: 'xs', align: 'end', hideBelow: 'sm' }
  ]
}

function filaWorktree(w: Worktree): TableRow {
  return {
    key: w.ruta,
    cells: {
      worktree: nombreWorktree(w),
      estado: t().veredictos[w.veredicto],
      disco: w.kb === null ? '—' : memoria(w.kb),
      quieto: w.ultimaActividad === null ? '—' : { type: 'relative', at: w.ultimaActividad, format: 'duration' }
    },
    // Los que no se pueden cerrar (en uso, de Orca, bloqueados) tampoco se marcan.
    disabled: !w.cerrable
  }
}

function DetallesWorktrees(props: { lista: readonly Worktree[]; home: string }) {
  if (!props.lista.length) return null
  const tx = t()
  return (
    <Stack gap="sm">
      {props.lista.slice(0, 3).map((w) => (
        <Stack gap="xs">
          <Text size="sm" weight="medium">
            {nombreWorktree(w)}
          </Text>
          <Text size="sm" tone={w.veredicto === 'revisar' ? 'warning' : undefined}>
            {w.motivo}
          </Text>
          <Text muted size="xs">
            {[
              `${tx.panel.rama}: ${w.rama ?? tx.worktree.headSuelto}`,
              w.cambios + w.sinSeguir ? tx.panel.cambiosSinConfirmar(w.cambios + w.sinSeguir) : null,
              w.sinSubir ? tx.panel.commitsSinSubir(w.sinSubir) : null,
              `${tx.panel.creadoPor}: ${tx.worktree.origenes[w.origen]}`
            ]
              .filter(Boolean)
              .join(' · ')}
          </Text>
          <Code block>{abreviarRuta(w.ruta, props.home)}</Code>
        </Stack>
      ))}
      {props.lista.length > 3 ? <Text muted size="xs">{tx.panel.yMas(props.lista.length - 3)}</Text> : null}
    </Stack>
  )
}

function PestanaWorktrees(props: { f: Foto; ocupado: boolean }) {
  const { f, ocupado } = props
  const tx = t().panel
  if (f.worktreesRevisados === null) return <Skeleton lines={3} label={tx.buscandoWorktrees} />
  if (!f.worktrees.length) {
    return (
      <Stack gap="sm">
        <Accion origen="worktrees" />
        <EmptyState icon="check" title={tx.sinWorktrees} description={tx.ningunWorktree} />
      </Stack>
    )
  }
  const marcados = new Set(read(seleccion).worktrees ?? [])
  const elegidos = f.worktrees.filter((w) => marcados.has(w.ruta) && w.cerrable)
  const inactivos = worktreesParaCerrar(f)
  // La foto trae como mucho 200; los totales cuentan todos.
  const fuera = f.totales.worktrees - f.worktrees.length
  return (
    <Stack gap="sm">
      <Text muted size="sm">
        {tx.explicaWorktrees}
      </Text>
      <Table
        label={tx.worktreesTabla}
        columns={columnasWorktrees()}
        rows={f.worktrees.map(filaWorktree)}
        selectionMode="multiple"
        selected={elegidos.map((w) => w.ruta)}
        onSelectionChange={({ keys }) => update(seleccion, (sel) => ({ ...sel, worktrees: keys }))}
        maxHeight="lg"
      />
      {fuera > 0 ? (
        <Text muted size="xs">
          {tx.yMas(fuera)}
        </Text>
      ) : null}
      <DetallesWorktrees lista={elegidos} home={f.home} />
      {activo('worktrees') ? (
        <Accion origen="worktrees" />
      ) : (
        <Row gap="xs" wrap>
          <Button
            size="sm"
            tone="danger"
            disabled={!elegidos.length || ocupado}
            onPress={() => pedir(confirmarWorktrees('worktrees', elegidos, f.tomadaEn))}
          >
            {tx.cerrarSeleccionados(elegidos.length)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!inactivos.length}
            onPress={() => update(seleccion, (sel) => ({ ...sel, worktrees: inactivos.map((w) => w.ruta) }))}
          >
            {tx.marcarInactivos}
          </Button>
        </Row>
      )}
    </Stack>
  )
}

/** El aviso de arriba cuando hay worktrees inactivos sin nada que perder; su confirmación sale
 *  en su lugar. Es la propuesta del plugin: de una, solo los que no pierden nada. */
function AvisoWorktrees(props: { f: Foto; ocupado: boolean }) {
  const { f, ocupado } = props
  if (activo('aviso-worktrees')) return <Accion origen="aviso-worktrees" />
  const inactivos = worktreesParaCerrar(f)
  if (!inactivos.length) return null
  const tx = t()
  const disco = f.totales.worktreesCerrarKb
  return (
    <Callout tone="warning" title={tx.worktreesInactivos(inactivos.length)} icon="branch">
      <Stack gap="sm">
        <Text size="sm">{tx.panel.worktreesSobran(disco ? memoria(disco) : '')}</Text>
        <Row gap="xs">
          <Button
            size="sm"
            tone="danger"
            disabled={ocupado}
            onPress={() => pedir(confirmarWorktrees('aviso-worktrees', inactivos, f.tomadaEn))}
          >
            {tx.panel.cerrarWorktrees(inactivos.length)}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(pestana, 'worktrees')}>
            {tx.panel.ver}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

/** El aviso de arriba cuando hay huérfanos seguros; su confirmación sale en su lugar. */
function AvisoHuerfanos(props: { f: Foto; ocupado: boolean }) {
  const { f, ocupado } = props
  if (activo('aviso')) return <Accion origen="aviso" />
  const tot = f.totales
  const seguros = huerfanosSeguros(f)
  if (!seguros.length) return null
  const tx = t()
  return (
    <Callout tone="danger" title={tx.procesosHuerfanos(tot.huerfanosSeguros)} icon="warning">
      <Stack gap="sm">
        <Text size="sm">{tx.panel.siguieronVivos(memoria(tot.huerfanosRssKb), puertos(tot.puertosHuerfanos))}</Text>
        <Row gap="xs">
          <Button
            size="sm"
            tone="danger"
            disabled={ocupado}
            onPress={() => pedir(confirmarHuerfanos('aviso', seguros, f.huerfanos, f.home))}
          >
            {tot.huerfanosSeguros === 1 ? tx.panel.cerrarlo : tx.panel.cerrarTodos}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(pestana, 'huerfanos')}>
            {tx.panel.ver}
          </Button>
        </Row>
      </Stack>
    </Callout>
  )
}

export default function Panel() {
  const f = read(foto)
  const fallo = read(falloPedido)
  const ocupado = read(cerrando) !== null
  const tot = f?.totales
  const tx = t()

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>{tx.nombrePlugin}</Heading>
        <IconButton icon="refresh" label={tx.panel.revisarAhora} disabled={ocupado} onPress={refrescar} />
      </Row>

      {f && tot && !f.error ? (
        <Text muted size="xs">
          {tx.sesiones(tot.sesiones)} · {tx.procesos(tot.procesos)} · {memoria(tot.rssKb)} · {tx.panel.revisado}{' '}
          <RelativeTime at={f.tomadaEn} format="short" />
        </Text>
      ) : null}

      {fallo ? (
        <Callout tone="danger" title={tx.panel.workerNoRespondio} icon="error">
          {fallo}
        </Callout>
      ) : null}
      {f?.error ? (
        <Callout tone="danger" title={tx.panel.noPudeLeer} icon="error">
          {f.error}
        </Callout>
      ) : null}

      {f && !f.error ? <AvisoHuerfanos f={f} ocupado={ocupado} /> : null}
      {f && !f.error ? <AvisoWorktrees f={f} ocupado={ocupado} /> : null}

      {!f ? (
        fallo ? null : <Skeleton lines={4} label={tx.panel.revisando} />
      ) : (
        <Tabs label={tx.panel.vista} value={read(pestana)} onChange={(v) => set(pestana, v)}>
          <Tab value="sesiones" label={tx.panel.pestanaSesiones(f.sesiones.length)} icon="agent">
            <PestanaSesiones f={f} ocupado={ocupado} />
          </Tab>
          <Tab value="huerfanos" label={tx.panel.pestanaHuerfanos(f.huerfanos.length)} icon="warning">
            <PestanaHuerfanos f={f} ocupado={ocupado} />
          </Tab>
          <Tab value="worktrees" label={tx.panel.pestanaWorktrees(f.totales.worktrees)} icon="branch">
            <PestanaWorktrees f={f} ocupado={ocupado} />
          </Tab>
        </Tabs>
      )}
    </Stack>
  )
}
