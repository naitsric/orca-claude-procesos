// `orca plugin check` pinta el panel una vez por escenario. `maquina` usa el worker de verdad;
// `conHuerfanos` responde con el sistema inventado de fixtures.ts para ver todos los estados.
import { defineCheck } from 'orca/testing'
import { fotoDePrueba } from './fixtures'

export default defineCheck({
  maquina: { settings: { intervaloSegundos: 300, avisarHuerfanos: false } },
  conHuerfanos: { requests: { 'procesos.foto': () => fotoDePrueba() } }
})
