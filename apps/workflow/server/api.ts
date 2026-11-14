import { Hono } from 'hono'

import * as appsIdApiKeysKeyId from '@/app/api/apps/[id]/api-keys/[keyId]/route'
import * as appsIdApiKeys from '@/app/api/apps/[id]/api-keys/route'
import * as appsIdExecutions from '@/app/api/apps/[id]/executions/route'
import * as appsIdPublish from '@/app/api/apps/[id]/publish/route'
import * as appsId from '@/app/api/apps/[id]/route'
import * as appsIdStats from '@/app/api/apps/[id]/stats/route'
import * as appsIdUnpublish from '@/app/api/apps/[id]/unpublish/route'
import * as appsIdWorkflowExecutionsExecutionId from '@/app/api/apps/[id]/workflow/executions/[executionId]/route'
import * as appsIdWorkflowExecutions from '@/app/api/apps/[id]/workflow/executions/route'
import * as appsIdWorkflow from '@/app/api/apps/[id]/workflow/route'
import * as appsIdWorkflowRun from '@/app/api/apps/[id]/workflow/run/route'
import * as apps from '@/app/api/apps/route'
import * as authLogin from '@/app/api/auth/login/route'
import * as authLogout from '@/app/api/auth/logout/route'
import * as authMe from '@/app/api/auth/me/route'
import * as authRegister from '@/app/api/auth/register/route'
import * as blogId from '@/app/api/blog/[id]/route'
import * as blog from '@/app/api/blog/route'
import * as knowledgeIdDocumentsDocIdChunks from '@/app/api/knowledge/[id]/documents/[docId]/chunks/route'
import * as knowledgeIdDocumentsDocId from '@/app/api/knowledge/[id]/documents/[docId]/route'
import * as knowledgeIdDocuments from '@/app/api/knowledge/[id]/documents/route'
import * as knowledgeId from '@/app/api/knowledge/[id]/route'
import * as knowledgeIdSearch from '@/app/api/knowledge/[id]/search/route'
import * as knowledge from '@/app/api/knowledge/route'
import * as runWorkflowTest from '@/app/api/run-workflow-test/route'
import { apiError, ErrorCode } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'

export const api = new Hono({ strict: false })

api.post('/api/auth/login', c => authLogin.POST(c.req.raw))
api.post('/api/auth/register', c => authRegister.POST(c.req.raw))

api.use('/api/*', async (c, next) => {
    if (!getCurrentUserId(c.req.raw)) return apiError(ErrorCode.UNAUTHORIZED)
    await next()
})

api.get('/api/apps/:id/api-keys/:keyId', c =>
    appsIdApiKeysKeyId.GET(c.req.raw, { params: { id: c.req.param('id'), keyId: c.req.param('keyId') } })
)
api.put('/api/apps/:id/api-keys/:keyId', c =>
    appsIdApiKeysKeyId.PUT(c.req.raw, { params: { id: c.req.param('id'), keyId: c.req.param('keyId') } })
)
api.delete('/api/apps/:id/api-keys/:keyId', c =>
    appsIdApiKeysKeyId.DELETE(c.req.raw, { params: { id: c.req.param('id'), keyId: c.req.param('keyId') } })
)
api.get('/api/apps/:id/api-keys', c => appsIdApiKeys.GET(c.req.raw, { params: { id: c.req.param('id') } }))
api.post('/api/apps/:id/api-keys', c => appsIdApiKeys.POST(c.req.raw, { params: { id: c.req.param('id') } }))
api.get('/api/apps/:id/executions', c => appsIdExecutions.GET(c.req.raw, { params: { id: c.req.param('id') } }))
api.get('/api/apps/:id/publish', c => appsIdPublish.GET(c.req.raw, { params: { id: c.req.param('id') } }))
api.post('/api/apps/:id/publish', c => appsIdPublish.POST(c.req.raw, { params: { id: c.req.param('id') } }))
api.get('/api/apps/:id', c => appsId.GET(c.req.raw, { params: { id: c.req.param('id') } }))
api.put('/api/apps/:id', c => appsId.PUT(c.req.raw, { params: { id: c.req.param('id') } }))
api.delete('/api/apps/:id', c => appsId.DELETE(c.req.raw, { params: { id: c.req.param('id') } }))
api.get('/api/apps/:id/stats', c => appsIdStats.GET(c.req.raw, { params: { id: c.req.param('id') } }))
api.post('/api/apps/:id/unpublish', c => appsIdUnpublish.POST(c.req.raw, { params: { id: c.req.param('id') } }))
api.get('/api/apps/:id/workflow/executions/:executionId', c =>
    appsIdWorkflowExecutionsExecutionId.GET(c.req.raw, { params: { id: c.req.param('id'), executionId: c.req.param('executionId') } })
)
api.delete('/api/apps/:id/workflow/executions/:executionId', c =>
    appsIdWorkflowExecutionsExecutionId.DELETE(c.req.raw, { params: { id: c.req.param('id'), executionId: c.req.param('executionId') } })
)
api.get('/api/apps/:id/workflow/executions', c => appsIdWorkflowExecutions.GET(c.req.raw, { params: { id: c.req.param('id') } }))
api.get('/api/apps/:id/workflow', c => appsIdWorkflow.GET(c.req.raw, { params: { id: c.req.param('id') } }))
api.post('/api/apps/:id/workflow', c => appsIdWorkflow.POST(c.req.raw, { params: { id: c.req.param('id') } }))
api.post('/api/apps/:id/workflow/run', c => appsIdWorkflowRun.POST(c.req.raw, { params: { id: c.req.param('id') } }))
api.get('/api/apps', c => apps.GET(c.req.raw))
api.post('/api/apps', c => apps.POST(c.req.raw))
api.post('/api/auth/logout', () => authLogout.POST())
api.get('/api/auth/me', c => authMe.GET(c.req.raw))
api.get('/api/blog/:id', c => blogId.GET(c.req.raw, { params: { id: c.req.param('id') } }))
api.get('/api/blog', () => blog.GET())
api.get('/api/knowledge/:id/documents/:docId/chunks', c =>
    knowledgeIdDocumentsDocIdChunks.GET(c.req.raw, { params: { id: c.req.param('id'), docId: c.req.param('docId') } })
)
api.get('/api/knowledge/:id/documents/:docId', c =>
    knowledgeIdDocumentsDocId.GET(c.req.raw, { params: { id: c.req.param('id'), docId: c.req.param('docId') } })
)
api.delete('/api/knowledge/:id/documents/:docId', c =>
    knowledgeIdDocumentsDocId.DELETE(c.req.raw, { params: { id: c.req.param('id'), docId: c.req.param('docId') } })
)
api.get('/api/knowledge/:id/documents', c => knowledgeIdDocuments.GET(c.req.raw, { params: { id: c.req.param('id') } }))
api.post('/api/knowledge/:id/documents', c => knowledgeIdDocuments.POST(c.req.raw, { params: { id: c.req.param('id') } }))
api.get('/api/knowledge/:id', c => knowledgeId.GET(c.req.raw, { params: { id: c.req.param('id') } }))
api.put('/api/knowledge/:id', c => knowledgeId.PUT(c.req.raw, { params: { id: c.req.param('id') } }))
api.delete('/api/knowledge/:id', c => knowledgeId.DELETE(c.req.raw, { params: { id: c.req.param('id') } }))
api.post('/api/knowledge/:id/search', c => knowledgeIdSearch.POST(c.req.raw, { params: { id: c.req.param('id') } }))
api.get('/api/knowledge', c => knowledge.GET(c.req.raw))
api.post('/api/knowledge', c => knowledge.POST(c.req.raw))
api.get('/api/run-workflow-test', () => runWorkflowTest.GET())
api.post('/api/run-workflow-test', c => runWorkflowTest.POST(c.req.raw))

api.all('/api/*', c => c.json({ error: '接口不存在' }, 404))
