import { prisma } from '@/lib/prisma'

export async function getPublishedWorkflow(id: string) {
    const app = await prisma.app.findFirst({
        where: { id, isDeleted: false, isPublished: true },
        select: { id: true, name: true, icon: true, activePublished: { select: { nodes: true } } },
    })

    if (!app?.activePublished) return null

    return {
        appId: app.id,
        appName: app.name,
        appIcon: app.icon,
        inputs: extractInputFields(app.activePublished.nodes as unknown[]),
    }
}

function extractInputFields(nodes: unknown[]): Array<{ name: string; type: 'string' | 'number'; label?: string }> {
    const startNode = (nodes as Array<{ type: string; data?: { config?: { inputs?: unknown[] } } }>).find(n => n.type === 'start')
    if (!startNode?.data?.config?.inputs) {
        return []
    }

    return (startNode.data.config.inputs as Array<{ name: string; type: string; label?: string }>).map(v => ({
        name: v.name,
        type: v.type === 'number' ? 'number' : 'string',
        label: v.label || v.name,
    }))
}
