/*
 * @Description:
 * @Version:
 * @Author: wx
 * @Date: 2026-11-12 20:12:18
 * @LastEditors: wx
 * @LastEditTime: 2026-11-12 20:25:37
 */
import { startReactServer } from '@aiflow/react-server'

await startReactServer(() => import('./api'), 3001)
