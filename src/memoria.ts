// El tamaño de la memoria (src/procesos.ts) al guardarla. Recuerda una semana de sesiones, unos
// 200 bytes cada una, en un solo valor de storage: con más de mil no cabría, Orca rechazaría
// guardarla y la revisión entera fallaría. Lo que no cabe se olvida, lo más viejo primero.
import { pesoEnBytes } from './historial'
import type { Memoria } from './procesos'

/** Lo más que ocupa la memoria al guardarla, con margen bajo `LIMITE_VALOR_BYTES`. */
export const LIMITE_MEMORIA_BYTES = 240_000

/**
 * En qué orden se olvidan las sesiones cuando la memoria no cabe, la más vieja primero en cada
 * grupo:
 *
 * 1. Las que terminaron y no dejaron ningún proceso vivo. Solo sirven para saber en qué
 *    repositorios buscar worktrees.
 * 2. Las que terminaron y dejaron procesos vivos: sin ella, sus huérfanos dejan de ser seguros.
 * 3. Las vivas, que se vuelven a anotar en la siguiente revisión.
 */
function ordenDeOlvido(m: Memoria): string[] {
  const conProcesos = new Set<string>()
  for (const g of Object.values(m.grupos)) conProcesos.add(g.sesion)
  for (const l of Object.values(m.linaje)) conProcesos.add(l.sesion)
  return Object.entries(m.sesiones)
    .map(([clave, s]) => ({
      clave,
      grupo: s.termino === null ? 3 : conProcesos.has(clave) ? 2 : 1,
      fecha: s.termino ?? s.inicio
    }))
    .sort((a, b) => a.grupo - b.grupo || a.fecha - b.fecha)
    .map((s) => s.clave)
}

/**
 * La memoria tal como cabe en `limite` bytes. Si ya cabe, la misma. Si no, sin las sesiones más
 * viejas (ver `ordenDeOlvido`) y sin sus grupos ni su linaje: las menos que haga falta, hasta
 * quedar vacía. Nunca devuelve más de `limite`.
 */
export function ajustarMemoria(m: Memoria, limite = LIMITE_MEMORIA_BYTES): Memoria {
  if (pesoEnBytes(m) <= limite) return m
  const orden = ordenDeOlvido(m)
  const sin = (n: number): Memoria => {
    const fuera = new Set(orden.slice(0, n))
    const queda = (clave: string): boolean => clave in m.sesiones && !fuera.has(clave)
    const filtrar = <T>(mapa: Record<string, T>, vale: (clave: string, valor: T) => boolean): Record<string, T> =>
      Object.fromEntries(Object.entries(mapa).filter(([clave, valor]) => vale(clave, valor)))
    return {
      v: 1,
      sesiones: filtrar(m.sesiones, (clave) => queda(clave)),
      grupos: filtrar(m.grupos, (_, g) => queda(g.sesion)),
      linaje: filtrar(m.linaje, (_, l) => queda(l.sesion))
    }
  }
  // Olvidar más sesiones siempre ocupa menos: se busca por mitades cuántas son las menos.
  let menos = 1
  let mas = orden.length
  while (menos < mas) {
    const medio = Math.floor((menos + mas) / 2)
    if (pesoEnBytes(sin(medio)) <= limite) mas = medio
    else menos = medio + 1
  }
  return sin(mas)
}
