import { isRouteErrorResponse, type LoaderFunctionArgs, useLoaderData, useRouteError } from 'react-router'

import { WorkflowRunner } from '@/components/workflow-runner'
import type { InputField } from '@/lib/types'

interface PublishedWorkflow {
    appId: string
    appName: string
    appIcon: string
    inputs: InputField[]
}

export async function loadWorkflow({ params, request }: LoaderFunctionArgs): Promise<PublishedWorkflow> {
    const response = await fetch(`/api/workflow/${encodeURIComponent(params.id ?? '')}`, { signal: request.signal })
    if (!response.ok) throw response
    return response.json()
}

export default function WorkflowPage() {
    const workflow = useLoaderData<typeof loadWorkflow>()
    return <WorkflowRunner key={workflow.appId} {...workflow} />
}

export function WorkflowError() {
    const error = useRouteError()
    return (
        <main className="p-8">
            {isRouteErrorResponse(error) && error.status === 404 ? '应用不存在或未发布' : '加载工作流失败，请稍后重试'}
        </main>
    )
}
