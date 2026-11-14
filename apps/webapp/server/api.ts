import { Hono } from 'hono'

import * as workflowIdRun from '@/app/api/workflow/[id]/run/route'

import { getPublishedWorkflow } from './published-workflow'

export const api = new Hono({ strict: false })

api.get('/api/workflow/:id', async c => {
    const workflow = await getPublishedWorkflow(c.req.param('id'))
    return workflow ? c.json(workflow) : c.json({ error: '应用不存在或未发布' }, 404)
})

api.post('/api/workflow/:id/run', c => workflowIdRun.POST(c.req.raw, { params: { id: c.req.param('id') } }))

api.all('/api/*', c => c.json({ error: '接口不存在' }, 404))
