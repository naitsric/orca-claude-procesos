// Panel lateral: sesiones de Claude, sus procesos y los huérfanos, con botones para cerrarlos.
// El worker (src/worker.ts) hace todo el trabajo; aquí solo se pinta la foto que publica.
//
// Cerrar algo pasa en el mismo lugar donde está el botón: la confirmación reemplaza a los botones
// (dentro de la tarjeta de la sesión, debajo de la tabla de huérfanos o en el aviso de arriba), y
// el resultado queda ahí mismo hasta que se pulsa «Listo». Cada acción lleva un `origen` para eso.
import {
  atom,
  Button,
  Callout,
  Code,
  Collapsible,
  EmptyState,
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
  type TableRow,
  type Tone
} from 'orca'
import { abreviarRuta, carpeta, duracion, memoria, plural, puertos } from './formato'
import type { Foto, Huerfano, Objetivo, Proceso, ResultadoCierre, Rol, Senal, Sesion, Veredicto } from './tipos'

type Nota = { texto: string; tono?: Tone }

/** Una acción esperando confirmación. Todo lo que muestra se arma al pedirla. */
type Pendiente = {
  origen: string
  titulo: string
  tono: 'warning' | 'danger'
  /** Encabezado de la lista: "Se cierran 7 procesos (284 MB):". */
  encabezado: string
  items: string[]
  notas: Nota[]
  boton: string
  cancelar: string
  /** Cómo se titula el resultado si todo sale bien. */
  hecho: string
  objetivos: Objetivo[]
  senal: Senal
  arbol: boolean
}

type Hecho = { origen: string; titulo: string; lista: ResultadoCierre[]; error?: string }

const foto = atom<Foto | null>(null)
const falloPedido = atom<string | null>(null)
const pendiente = atom<Pendiente | null>(null)
/** El origen de la acción que se está ejecutando. */
const cerrando = atom<string | null>(null)
const hecho = atom<Hecho | null>(null)
/** Filas marcadas por tabla: `s<pid>` para cada sesión, `huerfanos` para la otra pestaña. */
const seleccion = atom<Record<string, string[]>>({})
const abiertas = atom<Record<string, boolean>>({})
const pestana = atom('pestana', 'sesiones', { persist: 'plugin' })
const soloRevisar = atom('soloRevisar', false, { persist: 'plugin' })

const ESTADO: Record<Veredicto, string> = { cerrar: 'Cerrar', revisar: 'Revisar', dejar: 'Dejar' }

const ROL: Record<Rol, [string, string]> = {
  sesion: ['sesión de Claude', 'sesiones de Claude'],
  mcp: ['servidor MCP', 'servidores MCP'],
  bash: ['comando de Bash', 'comandos de Bash'],
  comando: ['proceso de un comando', 'procesos de comandos'],
  servidor: ['servidor', 'servidores'],
  tunel: ['túnel', 'túneles'],
  navegador: ['proceso del navegador', 'procesos del navegador'],
  despierto: ['caffeinate', 'caffeinate'],
  agente: ['otra sesión de Claude', 'otras sesiones de Claude'],
  otro: ['otro proceso', 'otros procesos']
}

const ORDEN_ROLES: readonly Rol[] = ['agente', 'mcp', 'bash', 'comando', 'servidor', 'tunel', 'navegador', 'despierto', 'otro']

function mensaje(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function refrescar(): Promise<void> {
  try {
    set(foto, await plugin.request('procesos.foto', undefined, { timeoutMs: 60_000 }))
    set(falloPedido, null)
  } catch (error) {
    set(falloPedido, mensaje(error))
  }
}

async function ejecutar(p: Pendiente): Promise<void> {
  set(pendiente, null)
  set(cerrando, p.origen)
  try {
    const respuesta = await plugin.request(
      'procesos.cerrar',
      { objetivos: p.objetivos, senal: p.senal, arbol: p.arbol },
      { timeoutMs: 60_000 }
    )
    set(foto, respuesta.foto)
    set(hecho, { origen: p.origen, titulo: p.hecho, lista: respuesta.resultados })
    set(seleccion, {})
  } catch (error) {
    set(hecho, { origen: p.origen, titulo: p.hecho, lista: [], error: mensaje(error) })
  } finally {
    set(cerrando, null)
  }
}

export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on('procesos.foto', (f) => set(foto, f)))
  void refrescar()
}

// ---------------------------------------------------------------------------------------------
// Armar lo que dice cada confirmación

function objetivo(p: { pid: number; inicio: number }): Objetivo {
  return { pid: p.pid, inicio: p.inicio }
}

function nombreSesion(s: Sesion, home: string): string {
  return s.nombre ?? carpeta(s.cwd, home)
}

function estadoCorto(s: Sesion, ahora: number): string {
  const desde = s.estadoDesde ? duracion(ahora - s.estadoDesde) : null
  if (s.estado === 'busy') return 'trabajando'
  if (s.estado === 'idle') return desde ? `inactiva ${desde}` : 'inactiva'
  if (s.estado) return desde ? `${s.estado} ${desde}` : s.estado
  return `abierta ${duracion(ahora - s.inicio)}`
}

const suma = (lista: readonly { rssKb: number }[]): number => lista.reduce((n, p) => n + p.rssKb, 0)

const todosLosPuertos = (lista: readonly { puertos: number[] }[]): number[] =>
  [...new Set(lista.flatMap((p) => p.puertos))].sort((a, b) => a - b)

/** "6 servidores MCP · 160 MB", una línea por tipo de proceso. */
function porTipo(lista: readonly Proceso[]): string[] {
  return ORDEN_ROLES.flatMap((rol) => {
    const grupo = lista.filter((p) => p.rol === rol)
    if (!grupo.length) return []
    const enPuerto = todosLosPuertos(grupo)
    return [
      `${plural(grupo.length, ROL[rol][0], ROL[rol][1])} · ${memoria(suma(grupo))}` +
        (enPuerto.length ? ` · ${puertos(enPuerto)}` : '')
    ]
  })
}

/** Una línea por proceso, como mucho 5. */
function unoPorUno(lista: readonly (Proceso | Huerfano)[], detalle: (p: Proceso | Huerfano) => string): string[] {
  const lineas = lista.slice(0, 5).map((p) => {
    const extra = detalle(p)
    return `${p.nombre}${extra ? ` · ${extra}` : ''} · ${memoria(p.rssKb)}` + (p.puertos.length ? ` · ${puertos(p.puertos)}` : '')
  })
  if (lista.length > 5) lineas.push(`y ${lista.length - 5} más`)
  return lineas
}

/** Los descendientes de `raices` dentro de `todos`, sin repetir las raíces. */
function descendientes<T extends { pid: number; ppid: number }>(raices: readonly T[], todos: readonly T[]): T[] {
  const elegidos = new Set(raices.map((p) => p.pid))
  const res: T[] = []
  let frontera = new Set(elegidos)
  while (frontera.size) {
    const siguiente = new Set<number>()
    for (const p of todos) {
      if (frontera.has(p.ppid) && !elegidos.has(p.pid)) {
        elegidos.add(p.pid)
        res.push(p)
        siguiente.add(p.pid)
      }
    }
    frontera = siguiente
  }
  return res
}

function pedirCerrarSesion(s: Sesion, home: string, ahora: number): void {
  const nombre = nombreSesion(s, home)
  const desacoplados = s.procesos.filter((p) => p.desacoplado)
  const enPuerto = todosLosPuertos(s.procesos)
  const notas: Nota[] = []
  if (s.estado === 'busy') notas.push({ texto: 'Está trabajando ahora: la tarea en curso se corta.', tono: 'danger' })
  else if (s.estado === 'idle' && s.estadoDesde) notas.push({ texto: `Está inactiva desde hace ${duracion(ahora - s.estadoDesde)}.` })
  if (s.sessionId) notas.push({ texto: `La conversación no se pierde: la retomas con claude --resume ${s.sessionId}` })
  if (desacoplados.length) {
    notas.push({ texto: `Incluye ${plural(desacoplados.length, 'proceso que se había desprendido', 'procesos que se habían desprendido')} de la sesión.` })
  }
  if (enPuerto.length) notas.push({ texto: `Libera ${puertos(enPuerto)}.` })
  set(hecho, null)
  set(pendiente, {
    origen: `s${s.pid}`,
    titulo: `¿Cerrar la sesión «${nombre}»?`,
    tono: s.estado === 'busy' ? 'danger' : 'warning',
    encabezado: `Se cierran ${plural(1 + s.procesos.length, 'proceso', 'procesos')} (${memoria(s.rssTotalKb)}):`,
    items: [`claude, la sesión · ${memoria(s.rssKb)}`, ...porTipo(s.procesos)],
    notas,
    boton: 'Cerrar sesión',
    cancelar: 'Mantenerla abierta',
    hecho: `Cerré la sesión «${nombre}»`,
    objetivos: [objetivo(s), ...desacoplados.filter((p) => p.nivel === 0).map(objetivo)],
    senal: 'TERM',
    arbol: true
  })
}

function pedirCerrarDeSesion(s: Sesion, elegidos: readonly Proceso[], home: string): void {
  if (!elegidos.length) return
  const hijos = descendientes(elegidos, s.procesos)
  const notas: Nota[] = []
  if (hijos.length) notas.push({ texto: `Con ellos se ${hijos.length === 1 ? 'cierra' : 'cierran'} ${plural(hijos.length, 'proceso hijo', 'procesos hijos')}.` })
  if (elegidos.some((p) => p.rol === 'mcp' && !p.desacoplado)) {
    notas.push({ texto: 'La sesión pierde las herramientas de esos servidores MCP hasta que la reinicies.', tono: 'warning' })
  }
  if (elegidos.some((p) => ['bash', 'comando', 'servidor', 'tunel'].includes(p.rol) && p.veredicto === 'dejar')) {
    notas.push({ texto: 'Claude puede estar esperando a que ese comando termine; lo verá fallar.', tono: 'warning' })
  }
  notas.push({ texto: 'La sesión sigue abierta.' })
  const n = elegidos.length
  set(hecho, null)
  set(pendiente, {
    origen: `s${s.pid}`,
    titulo: `¿Cerrar ${plural(n, 'proceso', 'procesos')} de «${nombreSesion(s, home)}»?`,
    tono: 'warning',
    encabezado: `Se ${n === 1 ? 'cierra' : 'cierran'}:`,
    items: unoPorUno(elegidos, (p) => ROL[p.rol][0]),
    notas,
    boton: `Cerrar ${plural(n, 'proceso', 'procesos')}`,
    cancelar: 'Cancelar',
    hecho: `Cerré ${plural(n + hijos.length, 'proceso', 'procesos')}`,
    objetivos: elegidos.map(objetivo),
    senal: 'TERM',
    arbol: true
  })
}

function pedirCerrarHuerfanos(origen: string, elegidos: readonly Huerfano[], todos: readonly Huerfano[], home: string): void {
  if (!elegidos.length) return
  const hijos = descendientes(elegidos, todos)
  const probables = elegidos.filter((h) => h.certeza === 'probable')
  const enPuerto = todosLosPuertos([...elegidos, ...hijos])
  const notas: Nota[] = []
  if (hijos.length) notas.push({ texto: `Con ellos se ${hijos.length === 1 ? 'cierra' : 'cierran'} ${plural(hijos.length, 'proceso hijo', 'procesos hijos')}.` })
  if (probables.length < elegidos.length) notas.push({ texto: 'Su sesión de Claude ya terminó: nadie los está usando.' })
  if (probables.length) {
    notas.push({
      texto: `${probables.map((h) => h.nombre).join(', ')} podría ser de otra app (Cursor, Claude Desktop…).`,
      tono: 'warning'
    })
  }
  if (enPuerto.length) notas.push({ texto: `Libera ${puertos(enPuerto)}.` })
  const n = elegidos.length
  set(hecho, null)
  set(pendiente, {
    origen,
    titulo: `¿Cerrar ${plural(n, 'proceso huérfano', 'procesos huérfanos')}?`,
    tono: 'warning',
    encabezado: `Se ${n === 1 ? 'cierra' : 'cierran'}:`,
    items: unoPorUno(elegidos, (p) => {
      const h = p as Huerfano
      if (!h.origen) return h.certeza === 'probable' ? 'origen dudoso' : 'de una sesión que ya no existe'
      return `de «${h.origen.nombre ?? carpeta(h.origen.cwd, home)}»`
    }),
    notas,
    boton: `Cerrar ${plural(n, 'proceso', 'procesos')}`,
    cancelar: 'Cancelar',
    hecho: `Cerré ${plural(n + hijos.length, 'proceso', 'procesos')}`,
    objetivos: elegidos.map(objetivo),
    senal: 'TERM',
    arbol: true
  })
}

function pedirForzar(origen: string, vivos: readonly ResultadoCierre[], f: Foto | null): void {
  if (!f) return
  const inicios = new Map<number, number>()
  for (const s of f.sesiones) {
    inicios.set(s.pid, s.inicio)
    for (const p of s.procesos) inicios.set(p.pid, p.inicio)
  }
  for (const h of f.huerfanos) inicios.set(h.pid, h.inicio)
  const lista = vivos.filter((r) => inicios.has(r.pid))
  set(hecho, null)
  set(pendiente, {
    origen,
    titulo: `¿Forzar el cierre de ${plural(lista.length, 'proceso', 'procesos')}?`,
    tono: 'danger',
    encabezado: 'No respondieron al cierre normal:',
    items: lista.map((r) => `${r.nombre} · pid ${r.pid}`),
    notas: [{ texto: 'Forzar (SIGKILL) los termina en el acto, sin dejarles guardar nada.', tono: 'warning' }],
    boton: 'Forzar cierre',
    cancelar: 'Dejarlos así',
    hecho: `Forcé el cierre de ${plural(lista.length, 'proceso', 'procesos')}`,
    objetivos: lista.map((r) => ({ pid: r.pid, inicio: inicios.get(r.pid)! })),
    senal: 'KILL',
    arbol: false
  })
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
  const cerrados = h.lista.filter((r) => r.resultado === 'cerrado')
  const vivos = h.lista.filter((r) => r.resultado === 'sigue-vivo')
  const fallidos = h.lista.filter((r) => r.resultado === 'rechazado' || r.resultado === 'error')
  const todoBien = !h.error && !vivos.length && !fallidos.length
  const titulo = h.error
    ? 'No se pudo cerrar'
    : todoBien
      ? h.titulo
      : `Cerré ${cerrados.length} de ${plural(h.lista.length, 'proceso', 'procesos')}`
  return (
    <Callout tone={todoBien ? 'success' : 'warning'} title={titulo} icon={todoBien ? 'check' : 'warning'}>
      <Stack gap="xs">
        {h.error ? <Text size="sm">El worker no respondió: {h.error}</Text> : null}
        {todoBien && cerrados.length > 1 ? (
          <Text size="sm" muted>
            {plural(cerrados.length, 'proceso cerrado', 'procesos cerrados')}.
          </Text>
        ) : null}
        {vivos.length ? (
          <Text size="sm">Siguen vivos: {vivos.map((r) => `${r.nombre} (${r.pid})`).join(', ')}.</Text>
        ) : null}
        {fallidos.map((r) => (
          <Text size="sm">
            {r.nombre} ({r.pid}): {r.detalle ?? r.resultado}
          </Text>
        ))}
        <Row gap="xs">
          {vivos.length ? (
            <Button size="sm" tone="danger" onPress={() => pedirForzar(h.origen, vivos, props.f)}>
              Forzar cierre
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" onPress={() => set(hecho, null)}>
            Listo
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
        <Spinner label="Cerrando" labelHidden />
        <Text size="sm" muted>
          Cerrando…
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

const COLUMNAS: readonly TableColumn[] = [
  { key: 'proceso', label: 'Proceso', minWidth: 'sm' },
  { key: 'estado', label: 'Estado', width: 'xs' },
  { key: 'mem', label: 'Memoria', width: 'xs', align: 'end' },
  { key: 'edad', label: 'Tiempo', width: 'xs', align: 'end', hideBelow: 'sm' }
]

function fila(p: Proceso | Huerfano): TableRow {
  const sangria = p.nivel > 0 ? `${'  '.repeat(p.nivel - 1)}└ ` : ''
  const enPuerto = p.puertos.length ? ` ${puertos(p.puertos)}` : ''
  const estado = 'certeza' in p && p.certeza === 'probable' ? 'Revisar (?)' : ESTADO[p.veredicto]
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
          {'cwd' in p && p.cwd ? <Text muted size="xs">Carpeta: {abreviarRuta(p.cwd, props.home)}</Text> : null}
          <Code block>{p.comando}</Code>
        </Stack>
      ))}
      {props.lista.length > 3 ? <Text muted size="xs">y {props.lista.length - 3} más…</Text> : null}
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
  const aviso = s.veredicto !== 'dejar' || s.procesos.some((p) => p.veredicto !== 'dejar')
  // Con una confirmación pendiente la tarjeta se queda abierta: es donde está la pregunta.
  const abierta = (read(abiertas)[clave] ?? false) || activo(clave)
  return (
    <Collapsible
      title={`${aviso ? '⚠ ' : ''}${nombreSesion(s, home)}`}
      description={[
        s.nombre ? carpeta(s.cwd, home) : null,
        estadoCorto(s, ahora),
        memoria(s.rssTotalKb),
        plural(s.procesos.length, 'proceso', 'procesos')
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
            { label: 'Carpeta', value: abreviarRuta(s.cwd, home), code: true },
            { label: 'Terminal', value: `${s.anfitrion} (${s.tty})` },
            { label: 'Abierta', value: `hace ${duracion(ahora - s.inicio)}` },
            { label: 'CPU', value: `${s.cpu.toFixed(1).replace('.', ',')} %` },
            ...(s.sessionId ? [{ label: '--resume', value: s.sessionId, code: true }] : [])
          ]}
        />
        {visibles.length ? (
          <Table
            label={`Procesos de la sesión ${s.pid}`}
            columns={COLUMNAS}
            rows={visibles.map(fila)}
            selectionMode="multiple"
            selected={[...marcados].filter((k) => visibles.some((p) => String(p.pid) === k))}
            onSelectionChange={({ keys }) => update(seleccion, (sel) => ({ ...sel, [clave]: keys }))}
            maxHeight="md"
          />
        ) : (
          <Text muted size="sm">
            {s.procesos.length ? 'Todos sus procesos están bien.' : 'No tiene procesos hijos.'}
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
              onPress={() => pedirCerrarDeSesion(s, elegidos, home)}
            >
              {elegidos.length ? `Cerrar ${plural(elegidos.length, 'seleccionado', 'seleccionados')}` : 'Cerrar seleccionados'}
            </Button>
            <Button
              size="sm"
              tone="danger"
              variant="outline"
              icon="stop"
              disabled={ocupado}
              onPress={() => pedirCerrarSesion(s, home, ahora)}
            >
              Cerrar sesión
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
    ? f.sesiones.filter((s) => s.veredicto !== 'dejar' || s.procesos.some((p) => p.veredicto !== 'dejar'))
    : f.sesiones
  // Una sesión cerrada desaparece de la lista; su resultado queda arriba de la lista.
  const h = read(hecho)
  const huerfano = h && h.origen.startsWith('s') && !f.sesiones.some((s) => `s${s.pid}` === h.origen) ? h.origen : null
  return (
    <Stack gap="sm">
      <Switch label="Solo lo que hay que revisar" checked={filtrar} onChange={(v) => set(soloRevisar, v)} />
      {huerfano ? <Accion origen={huerfano} /> : null}
      {sesiones.length ? (
        sesiones.map((s) => <TarjetaSesion sesion={s} home={f.home} filtrar={filtrar} ocupado={ocupado} />)
      ) : (
        <EmptyState
          icon="check"
          title={f.sesiones.length ? 'Nada que revisar' : 'No hay sesiones de Claude'}
          description={f.sesiones.length ? 'Todas las sesiones y sus procesos están en uso.' : 'Ningún proceso claude está corriendo.'}
        />
      )}
    </Stack>
  )
}

function PestanaHuerfanos(props: { f: Foto; ocupado: boolean }) {
  const { f, ocupado } = props
  if (!f.huerfanos.length) {
    return (
      <Stack gap="sm">
        <Accion origen="huerfanos" />
        <EmptyState icon="check" title="Sin huérfanos" description="Ningún proceso de Claude sobrevivió a su sesión." />
      </Stack>
    )
  }
  const marcados = new Set(read(seleccion).huerfanos ?? [])
  const elegidos = f.huerfanos.filter((h) => marcados.has(String(h.pid)))
  const seguros = f.huerfanos.filter((h) => h.certeza === 'segura' && h.nivel === 0)
  return (
    <Stack gap="sm">
      <Text muted size="sm">
        «Revisar (?)» es un servidor MCP suelto que puede ser de otra app. Los demás nacieron bajo una sesión de Claude que ya terminó.
      </Text>
      <Table
        label="Procesos huérfanos"
        columns={COLUMNAS}
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
            onPress={() => pedirCerrarHuerfanos('huerfanos', elegidos, f.huerfanos, f.home)}
          >
            {elegidos.length ? `Cerrar ${plural(elegidos.length, 'seleccionado', 'seleccionados')}` : 'Cerrar seleccionados'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!seguros.length}
            onPress={() => update(seleccion, (sel) => ({ ...sel, huerfanos: seguros.map((h) => String(h.pid)) }))}
          >
            Marcar los seguros
          </Button>
        </Row>
      )}
    </Stack>
  )
}

/** El aviso de arriba cuando hay huérfanos seguros; su confirmación sale en su lugar. */
function AvisoHuerfanos(props: { f: Foto; ocupado: boolean }) {
  const { f, ocupado } = props
  if (activo('aviso')) return <Accion origen="aviso" />
  const t = f.totales
  const seguros = f.huerfanos.filter((h) => h.certeza === 'segura' && h.nivel === 0)
  if (!seguros.length) return null
  return (
    <Callout tone="danger" title={plural(t.huerfanosSeguros, 'proceso huérfano', 'procesos huérfanos')} icon="warning">
      <Stack gap="sm">
        <Text size="sm">
          Siguieron vivos después de cerrar su sesión de Claude. Ocupan {memoria(t.huerfanosRssKb)}
          {t.puertosHuerfanos.length ? ` y ${puertos(t.puertosHuerfanos)}` : ''}.
        </Text>
        <Row gap="xs">
          <Button
            size="sm"
            tone="danger"
            disabled={ocupado}
            onPress={() => pedirCerrarHuerfanos('aviso', seguros, f.huerfanos, f.home)}
          >
            {t.huerfanosSeguros === 1 ? 'Cerrarlo' : 'Cerrar todos'}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => set(pestana, 'huerfanos')}>
            Ver
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
  const t = f?.totales

  return (
    <Stack gap="md">
      <Row justify="between" align="center">
        <Heading level={2}>Procesos de Claude</Heading>
        <IconButton icon="refresh" label="Revisar ahora" disabled={ocupado} onPress={refrescar} />
      </Row>

      {f && t && !f.error ? (
        <Text muted size="xs">
          {plural(t.sesiones, 'sesión', 'sesiones')} · {plural(t.procesos, 'proceso', 'procesos')} · {memoria(t.rssKb)} · revisado{' '}
          <RelativeTime at={f.tomadaEn} format="short" />
        </Text>
      ) : null}

      {fallo ? (
        <Callout tone="danger" title="El worker no respondió" icon="error">
          {fallo}
        </Callout>
      ) : null}
      {f?.error ? (
        <Callout tone="danger" title="No pude leer los procesos" icon="error">
          {f.error}
        </Callout>
      ) : null}

      {f && !f.error ? <AvisoHuerfanos f={f} ocupado={ocupado} /> : null}

      {!f ? (
        fallo ? null : <Skeleton lines={4} label="Revisando procesos" />
      ) : (
        <Tabs label="Vista" value={read(pestana)} onChange={(v) => set(pestana, v)}>
          <Tab value="sesiones" label={`Sesiones (${f.sesiones.length})`} icon="agent">
            <PestanaSesiones f={f} ocupado={ocupado} />
          </Tab>
          <Tab value="huerfanos" label={`Huérfanos (${f.huerfanos.length})`} icon="warning">
            <PestanaHuerfanos f={f} ocupado={ocupado} />
          </Tab>
        </Tabs>
      )}
    </Stack>
  )
}
