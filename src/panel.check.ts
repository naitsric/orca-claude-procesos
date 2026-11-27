// `orca plugin check` pinta el panel una vez por escenario. `maquina` usa el worker de verdad;
// `conHuerfanos` responde con el sistema inventado de fixtures.ts para ver todos los estados, y
// `conPedido` es ese mismo sistema después del comando «close certain orphans»: el panel abre
// con su pregunta.
import { defineCheck } from 'orca/testing'
import { huerfanosSeguros } from './confirmar'
import { fotoDePrueba } from './fixtures'

export default defineCheck({
  maquina: { settings: { intervaloSegundos: 300, avisarHuerfanos: false } },
  conHuerfanos: { requests: { 'procesos.foto': () => fotoDePrueba(), 'procesos.tomarConfirmacion': { pedido: null } } },
  conPedido: {
    requests: {
      'procesos.foto': () => fotoDePrueba(),
      'procesos.tomarConfirmacion': () => ({
        pedido: {
          de: 'huerfanos' as const,
          huerfanos: huerfanosSeguros(fotoDePrueba()).map((h) => ({ pid: h.pid, inicio: h.inicio, nombre: h.nombre }))
        }
      })
    }
  }
})
