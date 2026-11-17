// Panel «Actividad de Claude»: lo que cuesta Claude en el tiempo, como la parte de abajo del
// Monitor de Actividad. Es un panel HTML (los componentes de Orca no tienen gráficas): Orca
// transpila este archivo y lo carga en una página propia. Todo sale del worker: el historial de
// muestras (cada 5 s) y la foto de la última revisión completa.
//
// También se cierra desde aquí, como en el Monitor de Actividad: cada sesión tiene su botón y los
// huérfanos seguros un aviso con el suyo. Preguntan lo mismo que el panel «Procesos de Claude»
// (./confirmar) y la confirmación y el resultado salen en el lugar del botón.
//
// Colores: azul, naranja, aguamarina, amarillo y violeta para las sesiones (la paleta categórica
// de referencia, con violeta en lugar de magenta: el magenta se confunde con el rojo de alerta) y
// rojo de alerta para los huérfanos, en la base de la pila, junto al azul. Validada en claro y
// oscuro sobre pares vecinos. El naranja queda cerca del rojo (ΔE 6,8 en oscuro) pero nunca son
// vecinos, y los huérfanos llevan siempre ⚠ y su nombre. En claro, aguamarina y amarillo quedan
// bajo 3:1 contra el fondo: por eso hay leyenda siempre y vista de tabla.
import {
  confirmarDeSesion,
  confirmarForzar,
  confirmarHuerfanos,
  confirmarSesion,
  estadoCorto,
  huerfanosSeguros,
  nombreSesion,
  resumirHecho,
  tieneAviso,
  type Hecho,
  type Pendiente
} from './confirmar'
import { duracion, memoria, plural, puertos } from './formato'
import {
  apilar,
  construirSeries,
  etiquetaMemoria,
  marcas,
  marcasMemoria,
  masCercana,
  type ColorSerie,
  type Datos,
  type Medida,
  type Serie
} from './series'
import type { Foto, Historial, Muestra, MuestraSesion, Proceso, Sesion } from './tipos'

const RANGOS = [5, 15, 30] as const
const CLAVE_RANGO = 'graficas.rango'
const ALTO_GRAFICA = 150

let historial: Historial | null = null
let foto: Foto | null = null
let rango = 5
let fallo: string | null = null
/** La muestra bajo el puntero (o el foco) en cada gráfica, por tiempo: sobrevive al repintado. */
const cursor: Record<Medida, number | null> = { cpu: null, rssKb: null }
// Cerrar: la confirmación, el cierre en curso y el resultado. `origen` dice dónde salen: `s<pid>`
// en la fila de esa sesión, `huerfanos` en el aviso de arriba.
let pendiente: Pendiente | null = null
let cerrando: string | null = null
let hecho: Hecho | null = null
/** El `data-foco` que debe quedar enfocado después del próximo repintado. */
let enfocarDespues: string | null = null
/** El botón que abrió la confirmación en curso: ahí vuelve el foco si se cancela. */
let volverA: string | null = null
/** Sesiones con su lista de procesos desplegada, y los procesos marcados en cada una (por pid). */
const desplegadas = new Set<string>()
const marcados = new Map<string, Set<number>>()

// ---------------------------------------------------------------------------------------------
// Estilos

const CSS = `
:root {
  --s0: #2a78d6; --s1: #eb6834; --s2: #1baf7a; --s3: #eda100; --s4: #6250d6;
  --otras: #898781; --huerfanos: #d03b3b; --vivo: #0ca30c;
  --peligro: var(--orca-destructive, #d03b3b); --cuidado: #b26b00;
  --tinta: var(--orca-foreground); --tinta-2: var(--orca-muted-foreground);
  --grid: color-mix(in srgb, var(--orca-foreground) 9%, transparent);
  --eje: color-mix(in srgb, var(--orca-foreground) 24%, transparent);
  --superficie: var(--orca-card, var(--orca-background));
}
html.dark { --s0: #3987e5; --s1: #d95926; --s2: #199e70; --s3: #c98500; --s4: #9085e9; --cuidado: #e2a336; }
* { box-sizing: border-box; }
body {
  margin: 0; padding: 12px 12px 24px;
  font: 13px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
  color: var(--tinta); background: var(--orca-background);
}
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
h1 { font-size: 15px; font-weight: 600; margin: 0; }
.vivo { font-size: 11px; color: var(--tinta-2); display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.vivo i { width: 7px; height: 7px; border-radius: 50%; background: var(--vivo); animation: pulso 2s infinite; }
.vivo.quieto i { background: var(--tinta-2); animation: none; }
@keyframes pulso {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--vivo) 55%, transparent); }
  70% { box-shadow: 0 0 0 6px transparent; }
  100% { box-shadow: 0 0 0 0 transparent; }
}
@media (prefers-reduced-motion: reduce) { .vivo i { animation: none; } }
.rangos { display: inline-flex; border: 1px solid var(--orca-border); border-radius: 8px; padding: 2px; gap: 2px; margin-bottom: 12px; }
.rangos button {
  font: inherit; font-size: 12px; border: 0; background: transparent; color: var(--tinta-2);
  padding: 3px 10px; border-radius: 6px; cursor: pointer;
}
.rangos button:hover { color: var(--tinta); }
.rangos button[aria-pressed="true"] { background: var(--orca-accent); color: var(--orca-accent-foreground); font-weight: 600; }
.rangos button:focus-visible, details summary:focus-visible { outline: 2px solid var(--orca-ring); outline-offset: 1px; }
.kpis { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
.kpi, .tarjeta { background: var(--superficie); border: 1px solid var(--orca-border); border-radius: 10px; }
.kpi { padding: 10px 10px 8px; min-width: 0; }
.kpi .etq { font-size: 11px; color: var(--tinta-2); }
.kpi .val { font-size: 22px; font-weight: 600; line-height: 1.15; margin-top: 2px; }
.kpi .sub { font-size: 11px; color: var(--tinta-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.kpi .icono { color: var(--huerfanos); margin-right: 4px; }
.kpi svg { display: block; width: 100%; height: 26px; margin-top: 6px; overflow: visible; }
.tarjeta { padding: 10px; margin-bottom: 12px; }
.tarjeta h2 { font-size: 12px; font-weight: 600; margin: 0 0 6px; display: flex; justify-content: space-between; gap: 8px; }
.tarjeta h2 span { font-weight: 400; color: var(--tinta-2); font-variant-numeric: tabular-nums; }
.leyenda { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--tinta-2); margin: 0 0 10px; }
.leyenda span { display: inline-flex; align-items: center; gap: 5px; min-width: 0; }
.muestra { width: 10px; height: 10px; border-radius: 2px; flex: none; display: inline-block; }
.grafica { position: relative; }
.grafica svg { display: block; width: 100%; overflow: visible; }
.grafica svg:focus { outline: none; }
.grafica svg:focus-visible { outline: 2px solid var(--orca-ring); outline-offset: 2px; border-radius: 4px; }
.grafica text { fill: var(--tinta-2); font-size: 10px; font-variant-numeric: tabular-nums; }
.vacio { color: var(--tinta-2); font-size: 12px; padding: 24px 0; text-align: center; }
.tip {
  position: absolute; top: 2px; pointer-events: none; z-index: 2; min-width: 130px;
  background: var(--orca-popover); color: var(--orca-popover-foreground);
  border: 1px solid var(--orca-border); border-radius: 8px; padding: 6px 8px; font-size: 11px;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
}
.tip .hora { color: var(--tinta-2); margin-bottom: 4px; }
.tip .fila { display: flex; align-items: center; gap: 6px; white-space: nowrap; }
.tip .fila b { font-weight: 600; min-width: 46px; text-align: right; font-variant-numeric: tabular-nums; }
.tip .fila span { color: var(--tinta-2); overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
.tip .clave { width: 12px; height: 2px; border-radius: 1px; flex: none; }
.tip .total { border-top: 1px solid var(--orca-border); margin-top: 4px; padding-top: 4px; }
.fila-barra { margin: 8px 0; }
.fila-barra .cab { display: flex; align-items: center; gap: 6px; font-size: 12px; }
.fila-barra .nombre { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fila-barra .cifra { color: var(--tinta-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.fila-barra .cifra b { color: var(--tinta); font-weight: 600; }
.pista { height: 6px; margin-top: 4px; border-radius: 3px; background: var(--grid); overflow: hidden; }
.pista div { height: 100%; border-radius: 3px; }
.ranking .pista { background: transparent; height: 8px; }
.ranking .pista div { border-radius: 0 4px 4px 0; background: var(--tinta-2); opacity: 0.6; }
.ranking .pista div.alerta { background: var(--huerfanos); opacity: 1; }
details summary { cursor: pointer; font-size: 12px; color: var(--tinta-2); }
table { width: 100%; border-collapse: collapse; font-size: 11px; margin-top: 6px; }
th, td { text-align: right; padding: 3px 4px; border-bottom: 1px solid var(--orca-border); font-variant-numeric: tabular-nums; }
th:first-child, td:first-child { text-align: left; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
th { font-weight: 600; color: var(--tinta-2); }
#aviso { margin-bottom: 12px; }
#aviso:empty { display: none; }
#aviso .caja { margin: 0; }
.fila-sesion .sub { font-size: 11px; color: var(--tinta-2); margin-top: 1px; padding-left: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
.fila-sesion .sub b { color: var(--tinta); font-weight: 600; }
.fila-sesion .pista { margin-left: 16px; }
.fila-sesion .aviso { color: var(--cuidado); }
.fila-sesion + .fila-sesion { border-top: 1px solid var(--orca-border); padding-top: 8px; }
.pie { font-size: 11px; color: var(--tinta-2); margin: 10px 0 0; }
.desplegar {
  font: inherit; font-size: 11px; color: var(--tinta-2); background: none; border: 0; border-radius: 4px;
  padding: 2px 4px; margin: 4px 0 0 12px; cursor: pointer; display: inline-flex; gap: 4px; align-items: center;
}
.desplegar:hover { color: var(--tinta); background: var(--orca-accent); }
.desplegar:focus-visible { outline: 2px solid var(--orca-ring); outline-offset: 1px; }
.desplegar .sobran { color: var(--cuidado); }
.procs { margin: 4px 0 0 16px; border: 1px solid var(--orca-border); border-radius: 8px; padding: 4px 0; }
.proc { display: flex; align-items: center; gap: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; }
.proc:hover { background: var(--orca-accent); }
.proc.marcado { background: color-mix(in srgb, var(--peligro) 9%, transparent); }
.proc input { margin: 0; flex: none; accent-color: var(--peligro); }
.proc input:disabled + span { opacity: 0.6; }
.proc .pnombre { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.proc .pnombre small { color: var(--tinta-2); font-size: 11px; }
.proc .pmem { color: var(--tinta-2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.etiqueta { font-size: 10px; line-height: 14px; padding: 0 5px; border-radius: 4px; border: 1px solid; white-space: nowrap; flex: none; }
.etiqueta.cerrar { color: var(--peligro); border-color: color-mix(in srgb, var(--peligro) 45%, transparent); }
.etiqueta.revisar { color: var(--cuidado); border-color: color-mix(in srgb, var(--cuidado) 45%, transparent); }
.procs .botones { padding: 6px 8px 2px; margin-top: 4px; border-top: 1px solid var(--orca-border); }
.procs .ayuda { font-size: 11px; color: var(--tinta-2); padding: 2px 8px 4px; margin: 0; }
.procs + .caja, .procs + .cerrando { margin-left: 16px; }
.caja {
  border: 1px solid var(--orca-border); border-left: 3px solid var(--tinta-2); border-radius: 8px;
  padding: 8px 10px; margin-top: 8px; background: var(--superficie); font-size: 12px; overflow-wrap: anywhere;
}
.caja.danger { border-left-color: var(--peligro); background: color-mix(in srgb, var(--peligro) 8%, var(--superficie)); }
.caja.warning { border-left-color: var(--cuidado); background: color-mix(in srgb, var(--cuidado) 8%, var(--superficie)); }
.caja.bien { border-left-color: var(--vivo); }
.caja .titulo { font-weight: 600; display: flex; gap: 6px; align-items: baseline; }
.caja .icono { flex: none; }
.caja.danger .icono { color: var(--peligro); }
.caja.warning .icono { color: var(--cuidado); }
.caja.bien .icono { color: var(--vivo); }
.caja .enc { margin-top: 6px; font-weight: 500; }
.caja ul { margin: 2px 0 0; padding-left: 16px; }
.caja li { margin: 1px 0; }
.caja p { margin: 6px 0 0; color: var(--tinta-2); }
.caja p.danger { color: var(--peligro); font-weight: 500; }
.caja p.warning { color: var(--tinta); }
.caja p.warning::before { content: "⚠ "; color: var(--cuidado); }
.botones { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.btn {
  font: inherit; font-size: 12px; line-height: 1.2; display: inline-flex; align-items: center; gap: 6px;
  padding: 5px 10px; border-radius: 6px; border: 1px solid var(--orca-border); background: transparent;
  color: var(--tinta); cursor: pointer; white-space: nowrap; flex: none;
}
.btn:hover:not(:disabled) { background: var(--orca-accent); color: var(--orca-accent-foreground); }
.btn.peligro { background: var(--peligro); border-color: var(--peligro); color: var(--orca-destructive-foreground, #fff); font-weight: 600; }
.btn.peligro:hover:not(:disabled) { background: color-mix(in srgb, var(--peligro) 85%, #000); color: var(--orca-destructive-foreground, #fff); }
.btn.suave { color: var(--peligro); border-color: color-mix(in srgb, var(--peligro) 40%, var(--orca-border)); padding: 3px 8px; font-size: 11px; }
.btn.suave:hover:not(:disabled) { background: color-mix(in srgb, var(--peligro) 12%, transparent); color: var(--peligro); }
.btn.fantasma { border-color: transparent; color: var(--tinta-2); }
.btn:disabled { opacity: 0.45; cursor: default; }
.btn:focus-visible { outline: 2px solid var(--orca-ring); outline-offset: 1px; }
.btn .alto { width: 8px; height: 8px; border-radius: 1.5px; background: currentColor; flex: none; }
.cerrando { display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 12px; color: var(--tinta-2); }
.giro { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--grid); border-top-color: var(--tinta-2); animation: giro 0.8s linear infinite; }
@keyframes giro { to { transform: rotate(360deg); } }
`

// ---------------------------------------------------------------------------------------------
// DOM

const NS = 'http://www.w3.org/2000/svg'

type Hijo = Node | string | null | undefined | false

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...hijos: Hijo[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  for (const h of hijos) if (h) e.append(h)
  return e
}

function s(tag: string, attrs: Record<string, string | number> = {}, ...hijos: Hijo[]): SVGElement {
  const e = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v))
  for (const h of hijos) if (h) e.append(h)
  return e
}

function color(c: ColorSerie): string {
  return c === 'otras' ? 'var(--otras)' : c === 'huerfanos' ? 'var(--huerfanos)' : `var(--s${c})`
}

function pct(v: number): string {
  return `${Math.round(v)} %`
}

const UNIDAD: Record<Medida, (v: number) => string> = { cpu: pct, rssKb: memoria }

function total(m: Muestra, medida: Medida): number {
  const huerfanos = medida === 'cpu' ? m.huerfanosCpu : m.huerfanosRssKb
  return m.sesiones.reduce((n, x) => n + x[medida], 0) + huerfanos
}

function hora(t: number): string {
  return new Date(t).toLocaleTimeString(orca.locale || 'es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

const raiz = {
  vivo: el('div', { class: 'vivo', role: 'status' }),
  rangos: el('div', { class: 'rangos', role: 'group', 'aria-label': 'Rango de tiempo' }),
  kpis: el('div', { class: 'kpis' }),
  aviso: el('div', { id: 'aviso' }),
  leyenda: el('div', { class: 'leyenda', 'aria-label': 'Leyenda' }),
  cpu: el('div', { class: 'grafica' }),
  cpuAhora: el('span'),
  mem: el('div', { class: 'grafica' }),
  memAhora: el('span'),
  ranking: el('div', { class: 'ranking' }),
  sesiones: el('div'),
  tabla: el('div')
}

function montar(): void {
  document.head.append(el('style', {}, CSS))
  document.body.append(
    el('header', {}, el('h1', {}, 'Actividad de Claude'), raiz.vivo),
    raiz.rangos,
    raiz.kpis,
    raiz.aviso,
    // Como en el Monitor de Actividad: primero la lista con su botón para cerrar, después las gráficas.
    el('section', { class: 'tarjeta' }, el('h2', {}, 'Sesiones'), raiz.sesiones),
    raiz.leyenda,
    el('section', { class: 'tarjeta' }, el('h2', {}, 'CPU', raiz.cpuAhora), raiz.cpu),
    el('section', { class: 'tarjeta' }, el('h2', {}, 'Memoria', raiz.memAhora), raiz.mem),
    el('section', { class: 'tarjeta' }, el('h2', {}, 'Dónde está la memoria'), raiz.ranking),
    raiz.tabla
  )
}

// ---------------------------------------------------------------------------------------------
// Piezas

function pintarRangos(): void {
  raiz.rangos.replaceChildren(
    ...RANGOS.map((min) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(min === rango), 'data-foco': `rango-${min}` }, `${min} min`)
      b.addEventListener('click', () => {
        rango = min
        void orca.storage.set(CLAVE_RANGO, min).catch(() => undefined)
        pintar()
      })
      return b
    })
  )
}

function pintarVivo(): void {
  const ultima = historial?.muestras.at(-1)
  const intervalo = historial?.intervaloMs ?? 5000
  const reciente = ultima && Date.now() - ultima.t < intervalo * 3
  raiz.vivo.className = reciente ? 'vivo' : 'vivo quieto'
  raiz.vivo.replaceChildren(el('i'), reciente ? `En vivo · cada ${Math.round(intervalo / 1000)} s` : 'Sin muestras recientes')
}

function chispa(valores: number[]): SVGElement {
  const g = s('svg', { viewBox: '0 0 100 26', preserveAspectRatio: 'none', 'aria-hidden': 'true' })
  if (valores.length < 2) return g
  const max = Math.max(...valores, 1e-9)
  const puntos = valores.map((v, i) => [(i / (valores.length - 1)) * 100, 24 - (v / max) * 22])
  g.append(
    s('polyline', {
      points: puntos.map((p) => p.join(',')).join(' '),
      fill: 'none',
      stroke: 'var(--tinta-2)',
      'stroke-width': 1.5,
      'stroke-linejoin': 'round',
      'stroke-linecap': 'round',
      'vector-effect': 'non-scaling-stroke'
    })
  )
  return g
}

function kpi(etq: string, valor: Hijo, sub: string, valores?: number[], alerta = false): HTMLElement {
  return el(
    'div',
    { class: 'kpi' },
    el('div', { class: 'etq' }, etq),
    el('div', { class: 'val' }, alerta ? el('span', { class: 'icono', 'aria-hidden': 'true' }, '⚠') : null, valor),
    el('div', { class: 'sub' }, sub),
    valores ? chispa(valores) : null
  )
}

function pintarKpis(muestras: Muestra[]): void {
  const ultima = muestras.at(-1)
  const cpus = muestras.map((m) => total(m, 'cpu'))
  const mems = muestras.map((m) => total(m, 'rssKb'))
  const sesiones = foto?.sesiones ?? []
  const trabajando = sesiones.filter((x) => x.estado === 'busy').length
  const huerfanos = foto?.totales.huerfanos ?? 0
  raiz.kpis.replaceChildren(
    kpi('CPU de Claude', ultima ? pct(total(ultima, 'cpu')) : '—', cpus.length ? `pico ${pct(Math.max(...cpus))} en ${rango} min` : ' ', cpus),
    kpi('Memoria', ultima ? memoria(total(ultima, 'rssKb')) : '—', mems.length ? `pico ${memoria(Math.max(...mems))}` : ' ', mems),
    kpi(
      'Sesiones',
      String(sesiones.length),
      sesiones.length ? `${trabajando} trabajando · ${sesiones.length - trabajando} esperando` : 'ninguna abierta'
    ),
    kpi(
      'Huérfanos',
      String(huerfanos),
      huerfanos ? `${memoria(foto!.totales.huerfanosRssKb)} sin dueño` : 'ninguno',
      undefined,
      huerfanos > 0
    )
  )
}

function pintarLeyenda(series: Serie[]): void {
  raiz.leyenda.replaceChildren(
    ...[...series].reverse().map((x) =>
      el(
        'span',
        {},
        el('i', { class: 'muestra', style: `background:${color(x.color)}` }),
        x.color === 'huerfanos' ? `⚠ ${x.nombre}` : x.nombre
      )
    )
  )
}

/** Áreas apiladas con su línea de borde, ejes discretos y una mira con tooltip. */
function grafica(cont: HTMLElement, datos: Datos, medida: Medida, desde: number, hasta: number, intervaloMs: number): void {
  cont.replaceChildren()
  if (datos.t.length < 2 || !datos.series.length) {
    cont.append(el('div', { class: 'vacio' }, 'Juntando datos: la gráfica aparece con la segunda muestra.'))
    return
  }
  const formato = UNIDAD[medida]
  const ancho = Math.max(200, cont.clientWidth || 300)
  const m = { izq: 46, der: 6, arr: 6, aba: 18 }
  const w = ancho - m.izq - m.der
  const h = ALTO_GRAFICA - m.arr - m.aba
  const pilas = apilar(datos.series)
  const cima = pilas[pilas.length - 1]
  const ticks = medida === 'cpu' ? marcas(Math.max(10, ...cima), 3) : marcasMemoria(Math.max(512 * 1024, ...cima), 3)
  const etiqueta = medida === 'cpu' ? (v: number) => (v === 0 ? '0' : pct(v)) : etiquetaMemoria
  const tope = ticks[ticks.length - 1]
  const x = (t: number) => m.izq + ((t - desde) / (hasta - desde)) * w
  const y = (v: number) => m.arr + h - (v / tope) * h

  const svg = s('svg', {
    viewBox: `0 0 ${ancho} ${ALTO_GRAFICA}`,
    height: ALTO_GRAFICA,
    tabindex: 0,
    role: 'img',
    'data-foco': `grafica-${medida}`,
    'aria-label': `${medida === 'cpu' ? 'CPU' : 'Memoria'} de Claude en los últimos ${rango} minutos. Flechas para recorrer.`
  })
  for (const v of ticks) {
    svg.append(
      s('line', { x1: m.izq, x2: ancho - m.der, y1: y(v), y2: y(v), stroke: v === 0 ? 'var(--eje)' : 'var(--grid)', 'stroke-width': 1 }),
      s('text', { x: m.izq - 6, y: y(v), 'text-anchor': 'end', 'dominant-baseline': 'middle' }, etiqueta(v))
    )
  }
  const etiquetasX: [number, string, string][] = [
    [desde, `−${rango} min`, 'start'],
    [desde + (hasta - desde) / 2, `−${Math.round(rango / 2)} min`, 'middle'],
    [hasta, 'ahora', 'end']
  ]
  for (const [t, texto, ancla] of etiquetasX) {
    svg.append(s('text', { x: x(t), y: ALTO_GRAFICA - 4, 'text-anchor': ancla }, texto))
  }

  // Tramos sin huecos: si el worker estuvo parado, la gráfica se corta en vez de inventar una rampa.
  const tramos: [number, number][] = []
  let inicio = 0
  for (let k = 1; k < datos.t.length; k++) {
    if (datos.t[k] - datos.t[k - 1] > intervaloMs * 3) {
      tramos.push([inicio, k - 1])
      inicio = k
    }
  }
  tramos.push([inicio, datos.t.length - 1])

  datos.series.forEach((serie, i) => {
    const arriba = pilas[i]
    const abajo = i ? pilas[i - 1] : arriba.map(() => 0)
    for (const [a, b] of tramos) {
      if (b <= a) continue
      const ks = Array.from({ length: b - a + 1 }, (_, j) => a + j)
      const ida = ks.map((k) => `${x(datos.t[k]).toFixed(1)},${y(arriba[k]).toFixed(1)}`)
      const vuelta = ks.map((k) => `${x(datos.t[k]).toFixed(1)},${y(abajo[k]).toFixed(1)}`).reverse()
      svg.append(
        s('path', { d: `M${ida.join('L')}L${vuelta.join('L')}Z`, fill: color(serie.color), 'fill-opacity': 0.22 }),
        s('path', {
          d: `M${ida.join('L')}`,
          fill: 'none',
          stroke: color(serie.color),
          'stroke-width': 2,
          'stroke-linejoin': 'round',
          'stroke-linecap': 'round'
        })
      )
    }
  })

  const mira = s('g', { 'pointer-events': 'none' })
  svg.append(mira)
  const tip = el('div', { class: 'tip', hidden: '' })
  cont.append(svg, tip)

  const mostrar = (idx: number | null): void => {
    mira.replaceChildren()
    if (idx === null) {
      tip.hidden = true
      return
    }
    const cx = x(datos.t[idx])
    mira.append(s('line', { x1: cx, x2: cx, y1: m.arr, y2: m.arr + h, stroke: 'var(--eje)', 'stroke-width': 1 }))
    datos.series.forEach((serie, i) => {
      if (serie.valores[idx] <= 0) return
      mira.append(
        s('circle', {
          cx,
          cy: y(pilas[i][idx]),
          r: 4,
          fill: color(serie.color),
          stroke: 'var(--superficie)',
          'stroke-width': 2
        })
      )
    })
    const filas = [...datos.series]
      .reverse()
      .filter((serie) => serie.valores[idx] > 0)
      .map((serie) =>
        el(
          'div',
          { class: 'fila' },
          el('i', { class: 'clave', style: `background:${color(serie.color)}` }),
          el('b', {}, formato(serie.valores[idx])),
          el('span', {}, serie.color === 'huerfanos' ? `⚠ ${serie.nombre}` : serie.nombre)
        )
      )
    tip.replaceChildren(
      el('div', { class: 'hora' }, `hace ${duracion(hasta - datos.t[idx])} · ${hora(datos.t[idx])}`),
      ...filas,
      el('div', { class: 'fila total' }, el('i', { class: 'clave' }), el('b', {}, formato(cima[idx])), el('span', {}, 'Total'))
    )
    tip.hidden = false
    // A la derecha de la mira si cabe; si no, a la izquierda, sin tapar el eje Y.
    const anchoTip = tip.offsetWidth || 150
    const izquierda = cx + 12 + anchoTip <= ancho ? cx + 12 : cx - 12 - anchoTip
    tip.style.left = `${Math.max(m.izq, Math.min(izquierda, ancho - anchoTip))}px`
  }

  const indice = (t: number | null): number | null => (t === null ? null : masCercana(datos.t, t))
  const mover = (idx: number | null): void => {
    cursor[medida] = idx === null ? null : datos.t[idx]
    mostrar(idx)
  }
  svg.addEventListener('pointermove', (ev) => {
    const caja = svg.getBoundingClientRect()
    const px = ((ev.clientX - caja.left) / caja.width) * ancho
    mover(masCercana(datos.t, desde + ((px - m.izq) / w) * (hasta - desde)))
  })
  svg.addEventListener('pointerleave', () => mover(null))
  svg.addEventListener('focus', () => mover(indice(cursor[medida]) ?? datos.t.length - 1))
  // Al repintar, la gráfica vieja sale del DOM y la nueva recupera el foco: eso no es un blur.
  svg.addEventListener('blur', () => {
    if (svg.isConnected) mover(null)
  })
  svg.addEventListener('keydown', (ev) => {
    const actual = indice(cursor[medida]) ?? datos.t.length - 1
    if (ev.key === 'ArrowLeft') mover(Math.max(0, actual - 1))
    else if (ev.key === 'ArrowRight') mover(Math.min(datos.t.length - 1, actual + 1))
    else if (ev.key === 'Escape') mover(null)
    else return
    ev.preventDefault()
  })
  mostrar(indice(cursor[medida]))
}

function filaBarra(nombre: Hijo[], cifra: Hijo[], fraccion: number, fondo: string, clase = ''): HTMLElement {
  return el(
    'div',
    { class: 'fila-barra' },
    el('div', { class: 'cab' }, ...nombre, el('span', { class: 'cifra' }, ...cifra)),
    el(
      'div',
      { class: 'pista' },
      el('div', { class: clase, style: `width:${Math.max(0, Math.min(1, fraccion)) * 100}%;${fondo ? `background:${fondo}` : ''}` })
    )
  )
}

/** Barras ordenadas, de un solo tono: en qué tipo de proceso está la memoria ahora. */
function pintarRanking(): void {
  if (!foto || foto.error) {
    raiz.ranking.replaceChildren(el('div', { class: 'vacio' }, 'Esperando la primera revisión.'))
    return
  }
  const grupos: [string, number, boolean][] = [
    ['Claude (las sesiones)', 0, false],
    ['Servidores MCP', 0, false],
    ['Comandos, servidores y túneles', 0, false],
    ['Navegadores', 0, false],
    ['Otros', 0, false],
    ['⚠ Huérfanos', foto.totales.huerfanosRssKb, true]
  ]
  for (const sesion of foto.sesiones) {
    grupos[0][1] += sesion.rssKb
    for (const p of sesion.procesos) {
      const i = p.rol === 'mcp' ? 1 : ['bash', 'comando', 'servidor', 'tunel'].includes(p.rol) ? 2 : p.rol === 'navegador' ? 3 : 4
      grupos[i][1] += p.rssKb
    }
  }
  const visibles = grupos.filter(([, kb]) => kb > 0).sort((a, b) => b[1] - a[1])
  const max = Math.max(...visibles.map(([, kb]) => kb), 1)
  raiz.ranking.replaceChildren(
    ...visibles.map(([nombre, kb, alerta]) =>
      filaBarra([el('span', { class: 'nombre' }, nombre)], [el('b', {}, memoria(kb))], kb / max, '', alerta ? 'alerta' : '')
    )
  )
}

/** Una fila por sesión, en el orden de sus colores: lo que gasta ahora y el botón para cerrarla. */
function pintarSesiones(ultima: Muestra | undefined, colores: Record<string, number>): void {
  const sesiones = foto && !foto.error ? foto.sesiones : []
  const hijos: HTMLElement[] = []
  // Una sesión recién cerrada ya no tiene fila: lo que quede de su acción sale arriba de la lista.
  const sinFila = [pendiente?.origen, cerrando, hecho?.origen].find(
    (o) => o?.startsWith('s') && !sesiones.some((x) => `s${x.pid}` === o)
  )
  const suelta = sinFila ? accion(sinFila) : null
  if (suelta) hijos.push(suelta)
  if (!sesiones.length) {
    hijos.push(el('div', { class: 'vacio' }, foto ? 'No hay sesiones de Claude abiertas.' : 'Esperando la primera revisión.'))
    raiz.sesiones.replaceChildren(...hijos)
    return
  }
  const enMuestra = new Map((ultima?.sesiones ?? []).map((x) => [x.clave, x]))
  // Orden fijo (el de los colores), para que la fila no se mueva bajo el puntero al ir a cerrarla.
  const turno = (x: Sesion) => {
    const c = colores[`s${x.pid}`]
    return c === undefined || c < 0 ? 99 : c
  }
  const lista = [...sesiones].sort((a, b) => turno(a) - turno(b) || a.pid - b.pid)
  const max = Math.max(...lista.map((x) => enMuestra.get(`s${x.pid}`)?.rssKb ?? x.rssTotalKb), 1)
  for (const x of lista) hijos.push(filaSesion(x, enMuestra.get(`s${x.pid}`), colores, max))
  hijos.push(
    el(
      'p',
      { class: 'pie' },
      'Despliega una sesión para cerrar solo algunos de sus procesos sin cerrarla. El detalle de cada uno está en el panel «Procesos de Claude».'
    )
  )
  raiz.sesiones.replaceChildren(...hijos)
}

function filaSesion(x: Sesion, enVivo: MuestraSesion | undefined, colores: Record<string, number>, max: number): HTMLElement {
  const clave = `s${x.pid}`
  const turno = colores[clave]
  const c = color(turno !== undefined && turno >= 0 ? turno : 'otras')
  const home = foto?.home ?? ''
  const nombre = nombreSesion(x, home)
  const mem = enVivo?.rssKb ?? x.rssTotalKb
  const cpu = enVivo?.cpu ?? x.cpu
  return el(
    'div',
    { class: 'fila-barra fila-sesion' },
    el(
      'div',
      { class: 'cab' },
      el('i', { class: 'muestra', style: `background:${c}` }),
      el('span', { class: 'nombre', title: nombre }, tieneAviso(x) ? el('span', { class: 'aviso' }, '⚠ ') : null, nombre),
      activo(clave)
        ? null
        : boton('Cerrar sesión', 'suave', () => pedir(confirmarSesion(x, home, Date.now())), {
            foco: `cerrar-${clave}`,
            detener: true,
            deshabilitado: cerrando !== null,
            etiqueta: `Cerrar la sesión ${nombre}`
          })
    ),
    el(
      'div',
      { class: 'sub' },
      // Cuántos procesos lo dice «Ver sus procesos (N)» justo debajo.
      `${estadoCorto(x, Date.now())} · ${x.procesos.length ? '' : 'sin procesos · '}`,
      el('b', {}, memoria(mem)),
      ` · ${pct(cpu)}`
    ),
    el('div', { class: 'pista' }, el('div', { style: `width:${Math.min(1, mem / max) * 100}%;background:${c}` })),
    x.procesos.length ? desplegar(x, clave) : null,
    x.procesos.length && desplegadas.has(clave) ? listaProcesos(x, clave, home) : null,
    accion(clave)
  )
}

/** «▸ Ver sus procesos (11) · 2 sobran»: abre o cierra la lista de procesos de la sesión. */
function desplegar(x: Sesion, clave: string): HTMLElement {
  const abierta = desplegadas.has(clave)
  const sobran = x.procesos.filter((p) => p.veredicto === 'cerrar').length
  const b = el(
    'button',
    { type: 'button', class: 'desplegar', 'aria-expanded': String(abierta), 'data-foco': `ver-${clave}` },
    `${abierta ? '▾ Ocultar' : '▸ Ver'} sus procesos (${x.procesos.length})`,
    sobran ? el('span', { class: 'sobran' }, `· ${sobran} ${sobran === 1 ? 'sobra' : 'sobran'}`) : null
  )
  b.addEventListener('click', () => {
    if (abierta) desplegadas.delete(clave)
    else desplegadas.add(clave)
    pintar()
  })
  return b
}

/** El veredicto de cada proceso, en palabras: «sobra» no le sirve a nadie, «revisar» decide tú. */
const ETIQUETA: Partial<Record<Proceso['veredicto'], string>> = { cerrar: 'sobra', revisar: 'revisar' }

/** Los procesos de la sesión con una casilla cada uno, para cerrar solo esos y dejar la sesión. */
function listaProcesos(x: Sesion, clave: string, home: string): HTMLElement {
  const vivos = new Set(x.procesos.map((p) => p.pid))
  const marc = new Set([...(marcados.get(clave) ?? [])].filter((pid) => vivos.has(pid)))
  marcados.set(clave, marc)
  const elegidos = x.procesos.filter((p) => marc.has(p.pid))
  const sobran = x.procesos.filter((p) => p.veredicto === 'cerrar')
  // Mientras se pregunta o se cierra, la selección no cambia: es la que se va a cerrar.
  const bloqueada = cerrando !== null || pendiente?.origen === clave
  const filas = x.procesos.map((p) => {
    const id = `p-${p.pid}`
    const casilla = el('input', { type: 'checkbox', id, 'data-foco': id })
    casilla.checked = marc.has(p.pid)
    casilla.disabled = bloqueada
    casilla.addEventListener('change', () => {
      if (hecho?.origen === clave) hecho = null
      if (casilla.checked) marc.add(p.pid)
      else marc.delete(p.pid)
      pintar()
    })
    const tag = ETIQUETA[p.veredicto]
    return el(
      'label',
      { class: `proc${marc.has(p.pid) ? ' marcado' : ''}`, for: id, title: `${p.motivo}\n${p.comando}` },
      casilla,
      el(
        'span',
        { class: 'pnombre', style: p.nivel > 1 ? `padding-left:${(p.nivel - 1) * 10}px` : '' },
        p.nivel > 1 ? '└ ' : '',
        p.nombre,
        p.puertos.length ? el('small', {}, ` ${puertos(p.puertos)}`) : null
      ),
      tag ? el('span', { class: `etiqueta ${p.veredicto}` }, tag) : null,
      el('span', { class: 'pmem' }, memoria(p.rssKb))
    )
  })
  const todasSobran = sobran.length > 0 && sobran.every((p) => marc.has(p.pid)) && marc.size === sobran.length
  return el(
    'div',
    { class: 'procs', role: 'group', 'aria-label': `Procesos de ${nombreSesion(x, home)}` },
    ...filas,
    activo(clave)
      ? null
      : el(
          'div',
          { class: 'botones' },
          boton(
            elegidos.length ? `Cerrar ${plural(elegidos.length, 'seleccionado', 'seleccionados')}` : 'Cerrar seleccionados',
            'suave',
            () => pedir(confirmarDeSesion(x, elegidos, home), `cerrar-sel-${clave}`),
            { foco: `cerrar-sel-${clave}`, detener: true, deshabilitado: !elegidos.length || cerrando !== null }
          ),
          sobran.length && !todasSobran
            ? boton(`Marcar los que sobran (${sobran.length})`, 'fantasma', () => {
                marcados.set(clave, new Set(sobran.map((p) => p.pid)))
                enfocarDespues = `cerrar-sel-${clave}`
                pintar()
              }, { foco: `marcar-${clave}` })
            : null
        ),
    activo(clave) ? null : el('p', { class: 'ayuda' }, 'La sesión sigue abierta; solo se cierran los marcados (y sus hijos).')
  )
}

/** Arriba, cuando hay huérfanos seguros: cuántos, qué ocupan y el botón para cerrarlos. */
function pintarAviso(): void {
  const enCurso = accion('huerfanos')
  if (enCurso) {
    raiz.aviso.replaceChildren(enCurso)
    return
  }
  const f = foto
  const seguros = f && !f.error ? huerfanosSeguros(f) : []
  if (!f || !seguros.length) {
    raiz.aviso.replaceChildren()
    return
  }
  const t = f.totales
  raiz.aviso.replaceChildren(
    el(
      'div',
      { class: 'caja danger', role: 'group', 'aria-label': 'Procesos huérfanos' },
      el('div', { class: 'titulo' }, el('span', { class: 'icono', 'aria-hidden': 'true' }, '⚠'), plural(t.huerfanosSeguros, 'proceso huérfano', 'procesos huérfanos')),
      el(
        'p',
        {},
        `Siguieron vivos después de cerrar su sesión de Claude. Ocupan ${memoria(t.huerfanosRssKb)}` +
          (t.puertosHuerfanos.length ? ` y ${puertos(t.puertosHuerfanos)}.` : '.')
      ),
      el(
        'div',
        { class: 'botones' },
        boton(
          t.huerfanosSeguros === 1 ? 'Cerrarlo' : 'Cerrar todos',
          'peligro',
          () => pedir(confirmarHuerfanos('huerfanos', seguros, f.huerfanos, f.home)),
          { foco: 'cerrar-huerfanos', detener: true, deshabilitado: cerrando !== null }
        )
      )
    )
  )
}

/** La vista de tabla: cada valor de las gráficas sin depender del color ni del puntero. */
function pintarTabla(muestras: Muestra[]): void {
  const ultima = muestras.at(-1)
  if (!ultima) {
    raiz.tabla.replaceChildren()
    return
  }
  const abierta = raiz.tabla.querySelector('details')?.open ?? false
  const pico = (clave: string, medida: Medida) =>
    Math.max(0, ...muestras.map((m) => m.sesiones.find((x) => x.clave === clave)?.[medida] ?? 0))
  const filas = [...ultima.sesiones]
    .sort((a, b) => b.rssKb - a.rssKb)
    .map((x) =>
      el(
        'tr',
        {},
        el('td', { title: x.nombre }, x.nombre),
        el('td', {}, pct(x.cpu)),
        el('td', {}, pct(pico(x.clave, 'cpu'))),
        el('td', {}, memoria(x.rssKb)),
        el('td', {}, memoria(pico(x.clave, 'rssKb')))
      )
    )
  if (ultima.huerfanosRssKb > 0) {
    filas.push(
      el('tr', {}, el('td', {}, '⚠ Huérfanos'), el('td', {}, pct(ultima.huerfanosCpu)), el('td', {}, '—'), el('td', {}, memoria(ultima.huerfanosRssKb)), el('td', {}, '—'))
    )
  }
  const detalles = el(
    'details',
    {},
    el('summary', {}, 'Ver como tabla'),
    el(
      'table',
      {},
      el('thead', {}, el('tr', {}, el('th', {}, 'Sesión'), el('th', {}, 'CPU'), el('th', {}, 'Pico'), el('th', {}, 'Memoria'), el('th', {}, 'Pico'))),
      el('tbody', {}, ...filas)
    )
  )
  detalles.open = abierta
  raiz.tabla.replaceChildren(detalles)
}

/** Repinta todo y deja el foco donde estaba (o donde lo pidió una acción): sin esto, un usuario de
 *  teclado lo perdería con cada muestra, cada 5 s. */
function pintar(): void {
  const antes = document.activeElement
  const foco = enfocarDespues ?? (antes instanceof HTMLElement || antes instanceof SVGElement ? antes.dataset.foco : undefined)
  enfocarDespues = null
  pintarTodo()
  if (!foco) return
  const destino = document.querySelector(`[data-foco="${foco}"]`)
  if ((destino instanceof HTMLElement || destino instanceof SVGElement) && destino !== document.activeElement) {
    destino.focus({ preventScroll: true })
  }
}

function pintarTodo(): void {
  pintarRangos()
  pintarVivo()
  if (fallo && !historial) {
    raiz.kpis.replaceChildren(el('div', { class: 'vacio' }, `El worker no respondió: ${fallo}`))
    return
  }
  const h = historial ?? { muestras: [], colores: {}, intervaloMs: 5000 }
  const hasta = h.muestras.at(-1)?.t ?? Date.now()
  const desde = hasta - rango * 60_000
  const muestras = h.muestras.filter((m) => m.t >= desde)
  const cpu = construirSeries(h, desde, 'cpu')
  const mem = construirSeries(h, desde, 'rssKb')
  const ultima = muestras.at(-1)

  pintarKpis(muestras)
  pintarAviso()
  pintarLeyenda(mem.series.length >= cpu.series.length ? mem.series : cpu.series)
  raiz.cpuAhora.textContent = ultima ? pct(total(ultima, 'cpu')) : ''
  raiz.memAhora.textContent = ultima ? memoria(total(ultima, 'rssKb')) : ''
  grafica(raiz.cpu, cpu, 'cpu', desde, hasta, h.intervaloMs)
  grafica(raiz.mem, mem, 'rssKb', desde, hasta, h.intervaloMs)
  pintarRanking()
  pintarSesiones(ultima, h.colores)
  pintarTabla(muestras)
}

// ---------------------------------------------------------------------------------------------
// Cerrar

function mensaje(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type OpcionesBoton = { foco?: string; detener?: boolean; deshabilitado?: boolean; etiqueta?: string }

function boton(texto: string, clase: string, alPulsar: () => void, op: OpcionesBoton = {}): HTMLButtonElement {
  const b = el('button', { type: 'button', class: `btn ${clase}` }, op.detener ? el('i', { class: 'alto', 'aria-hidden': 'true' }) : null, texto)
  if (op.foco) b.dataset.foco = op.foco
  if (op.etiqueta) b.setAttribute('aria-label', op.etiqueta)
  b.disabled = op.deshabilitado ?? false
  b.addEventListener('click', alPulsar)
  return b
}

/** Si hay algo que mostrar en `origen` (confirmación, cierre en curso o resultado). */
function activo(origen: string): boolean {
  return pendiente?.origen === origen || cerrando === origen || hecho?.origen === origen
}

function pedir(p: Pendiente | null, desde?: string): void {
  if (!p) return
  hecho = null
  pendiente = p
  volverA = desde ?? null
  // El foco va a la opción que no cierra nada, como en los diálogos de macOS.
  enfocarDespues = `no-${p.origen}`
  pintar()
}

async function ejecutar(p: Pendiente): Promise<void> {
  pendiente = null
  cerrando = p.origen
  pintar()
  try {
    const r = await orca.plugin.request(
      'procesos.cerrar',
      { objetivos: p.objetivos, senal: p.senal, arbol: p.arbol },
      { timeoutMs: 60_000 }
    )
    foto = r.foto
    hecho = { origen: p.origen, titulo: p.hecho, lista: r.resultados }
    marcados.delete(p.origen)
  } catch (error) {
    hecho = { origen: p.origen, titulo: p.hecho, lista: [], error: mensaje(error) }
  } finally {
    cerrando = null
    enfocarDespues = `listo-${p.origen}`
    pintar()
  }
}

function confirmacion(p: Pendiente): HTMLElement {
  return el(
    'div',
    { class: `caja ${p.tono}`, role: 'group', 'aria-label': p.titulo },
    el('div', { class: 'titulo' }, el('span', { class: 'icono', 'aria-hidden': 'true' }, '⚠'), p.titulo),
    el('div', { class: 'enc' }, p.encabezado),
    el('ul', {}, ...p.items.map((i) => el('li', {}, i))),
    ...p.notas.map((n) => el('p', n.tono ? { class: n.tono } : {}, n.texto)),
    el(
      'div',
      { class: 'botones' },
      boton(p.boton, 'peligro', () => void ejecutar(p), { foco: `si-${p.origen}`, detener: true }),
      boton(
        p.cancelar,
        'fantasma',
        () => {
          pendiente = null
          enfocarDespues = volverA ?? (p.origen === 'huerfanos' ? 'cerrar-huerfanos' : `cerrar-${p.origen}`)
          pintar()
        },
        { foco: `no-${p.origen}` }
      )
    )
  )
}

function resultado(h: Hecho): HTMLElement {
  const r = resumirHecho(h)
  return el(
    'div',
    { class: `caja ${r.todoBien ? 'bien' : 'warning'}`, role: 'status' },
    el('div', { class: 'titulo' }, el('span', { class: 'icono', 'aria-hidden': 'true' }, r.todoBien ? '✓' : '⚠'), r.titulo),
    ...r.lineas.map((l) => el('p', {}, l)),
    el(
      'div',
      { class: 'botones' },
      r.vivos.length
        ? boton('Forzar cierre', 'peligro', () => pedir(confirmarForzar(h.origen, r.vivos, foto)), { foco: `forzar-${h.origen}` })
        : null,
      boton(
        'Listo',
        'fantasma',
        () => {
          hecho = null
          pintar()
        },
        { foco: `listo-${h.origen}` }
      )
    )
  )
}

/** Lo que va en el lugar de la acción de `origen`, o null si no hay nada en curso ahí. */
function accion(origen: string): HTMLElement | null {
  if (pendiente?.origen === origen) return confirmacion(pendiente)
  if (cerrando === origen) {
    return el('div', { class: 'cerrando', role: 'status' }, el('i', { class: 'giro', 'aria-hidden': 'true' }), 'Cerrando…')
  }
  if (hecho?.origen === origen) return resultado(hecho)
  return null
}

// ---------------------------------------------------------------------------------------------
// Datos

async function iniciar(): Promise<void> {
  montar()
  const guardado = await orca.storage.get(CLAVE_RANGO).catch(() => null)
  if (typeof guardado === 'number' && (RANGOS as readonly number[]).includes(guardado)) rango = guardado
  pintar()

  orca.plugin.on('procesos.muestra', ({ muestra, colores }) => {
    const h = historial ?? { muestras: [], colores: {}, intervaloMs: 5000 }
    const muestras = [...h.muestras.filter((m) => muestra.t - m.t <= 30 * 60_000 && m.t < muestra.t), muestra]
    historial = { ...h, muestras, colores }
    pintar()
  })
  orca.plugin.on('procesos.foto', (f) => {
    foto = f
    pintar()
  })

  const [h, f] = await Promise.allSettled([
    orca.plugin.request('procesos.historial', undefined, { timeoutMs: 60_000 }),
    orca.plugin.request('procesos.foto', undefined, { timeoutMs: 60_000 })
  ])
  if (h.status === 'fulfilled') historial = h.value
  else fallo = h.reason instanceof Error ? h.reason.message : String(h.reason)
  if (f.status === 'fulfilled') foto = f.value
  pintar()

  let ancho = document.body.clientWidth
  new ResizeObserver(() => {
    if (document.body.clientWidth !== ancho) {
      ancho = document.body.clientWidth
      pintar()
    }
  }).observe(document.body)
  // El texto «En vivo» se apaga solo si el worker deja de mandar muestras.
  setInterval(pintarVivo, 5000)
}

void iniciar()
