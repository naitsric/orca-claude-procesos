// Formatos en español que usan el worker (motivos, barra de estado) y el panel.

export function memoria(kb: number): string {
  if (kb < 1024) return `${Math.round(kb)} KB`
  const mb = kb / 1024
  if (mb < 1024) return `${Math.round(mb)} MB`
  return `${(mb / 1024).toFixed(1).replace('.', ',')} GB`
}

/** "45 s", "12 min", "3 h", "2 d": la unidad más grande que cabe, sin decimales. */
export function duracion(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s} s`
  const min = Math.floor(s / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h`
  return `${Math.floor(h / 24)} d`
}

export function puertos(lista: readonly number[]): string {
  return lista.map((p) => `:${p}`).join(', ')
}

/** El último segmento de una ruta, o la ruta con ~ si es el home. */
export function carpeta(ruta: string | null, home?: string): string {
  if (!ruta) return '?'
  if (home && ruta === home) return '~'
  const partes = ruta.split('/').filter(Boolean)
  return partes[partes.length - 1] ?? ruta
}

export function abreviarRuta(ruta: string | null, home?: string): string {
  if (!ruta) return '—'
  return home && ruta.startsWith(home) ? `~${ruta.slice(home.length)}` : ruta
}

export function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`
}
