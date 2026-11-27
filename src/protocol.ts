// Contrato entre el panel y el worker, declarado una vez: src/panel.tsx y src/worker.ts lo leen.
import type {
  Foto,
  Historial,
  Muestra,
  Objetivo,
  ObjetivoWorktree,
  PedidoDeComando,
  ResultadoCierre,
  ResultadoWorktree,
  Senal
} from './tipos'

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Revisa los procesos ahora y devuelve la foto. Los paneles mandan el idioma de Orca, que el
     *  worker no conoce. */
    'procesos.foto': { input: { locale?: string } | undefined; output: Foto }
    /** Cierra procesos que estén en la foto actual y sigan como se vieron: el mismo `inicio` y,
     *  los que se pidieron como huérfanos, todavía huérfanos. Los que cambiaron vuelven como
     *  `rechazado`, con el motivo. Con `arbol`, también sus descendientes. */
    'procesos.cerrar': {
      input: { objetivos: Objetivo[]; senal: Senal; arbol: boolean }
      output: { resultados: ResultadoCierre[]; foto: Foto }
    }
    /** Quita worktrees que sigan como el panel los vio: en el mismo commit y sin que nadie los
     *  use. Borrar muchos tarda más de lo que un pedido puede esperar: entonces responde con los
     *  que lleva y `faltan`, sigue, y al terminar publica `procesos.worktreesCerrados`. */
    'procesos.cerrarWorktrees': {
      input: { objetivos: ObjetivoWorktree[] }
      output: { resultados: ResultadoWorktree[]; foto: Foto; faltan: number }
    }
    /** El pedido de confirmar que dejó hace poco un comando de la paleta («cerrar huérfanos
     *  seguros» o «cerrar worktrees inactivos»), o null. Quien pregunta se lo lleva: la siguiente
     *  respuesta es null. */
    'procesos.tomarConfirmacion': { output: { pedido: PedidoDeComando | null } }
    /** La última media hora de muestras, para las gráficas. Con muchas sesiones viene resumida
     *  (`Muestra.ms`) para no pasar de `LIMITE_HISTORIAL_BYTES`. */
    'procesos.historial': { output: Historial }
  }
  interface PluginPanelEvents {
    /** Cada revisión periódica del worker. */
    'procesos.foto': Foto
    /** Terminó un cierre de worktrees que había respondido con `faltan`: el resultado completo. */
    'procesos.worktreesCerrados': { resultados: ResultadoWorktree[] }
    /** Un comando de la paleta pide que un panel pregunte antes de cerrar: quien lo oye toma el
     *  pedido con `procesos.tomarConfirmacion`. */
    'procesos.confirmar': Record<string, never>
    /** Cada muestra para las gráficas, con los colores de sesión al día. */
    'procesos.muestra': { muestra: Muestra; colores: Record<string, number> }
  }
}
