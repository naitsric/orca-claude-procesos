// Contrato entre el panel y el worker, declarado una vez: src/panel.tsx y src/worker.ts lo leen.
import type { Foto, Historial, Muestra, Objetivo, ResultadoCierre, Senal } from './tipos'

export {}

declare module 'orca' {
  interface PluginRequests {
    /** Revisa los procesos ahora y devuelve la foto. */
    'procesos.foto': { output: Foto }
    /** Cierra procesos que estén en la foto actual. Con `arbol`, también sus descendientes. */
    'procesos.cerrar': {
      input: { objetivos: Objetivo[]; senal: Senal; arbol: boolean }
      output: { resultados: ResultadoCierre[]; foto: Foto }
    }
    /** La última media hora de muestras, para las gráficas. */
    'procesos.historial': { output: Historial }
  }
  interface PluginPanelEvents {
    /** Cada revisión periódica del worker. */
    'procesos.foto': Foto
    /** Cada muestra para las gráficas, con los colores de sesión al día. */
    'procesos.muestra': { muestra: Muestra; colores: Record<string, number> }
  }
}
