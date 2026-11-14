import { startReactServer } from '@aiflow/react-server'

await startReactServer(() => import('./api'), 3000)
