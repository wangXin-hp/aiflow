import { z } from 'zod'

import { apiError, apiSuccess, ErrorCode, handleApiError } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'
import { prisma } from '@/lib/prisma'
import { APP_TYPE_MAP, formatDate, toAppInfo } from '@/lib/types/app'

/**
 * GET /api/apps/[id] - 获取应用详情
 */
export async function GET(request: Request, { params }: { params: { id: string } }) {
    try {
        const userId = getCurrentUserId(request)
        if (!userId) {
            return apiError(ErrorCode.UNAUTHORIZED)
        }

        const { id } = params

        const app = await prisma.app.findFirst({
            where: {
                id,
                isDeleted: false,
            },
            include: {
                user: {
                    select: { name: true },
                },
            },
        })

        if (!app) {
            return apiError(ErrorCode.APP_NOT_FOUND)
        }

        // 检查权限
        if (app.userId !== userId) {
            return apiError(ErrorCode.APP_NOT_FOUND, '无权访问此应用')
        }

        return apiSuccess({
            ...toAppInfo({
                ...app,
                type: app.type,
            }),
            updatedAt: formatDate(app.updatedAt),
            createdAt: formatDate(app.createdAt),
            version: app.version,
            config: app.config,
            publishedAt: app.publishedAt ? formatDate(app.publishedAt) : null,
        })
    } catch (error) {
        return handleApiError(error)
    }
}

/**
 * PUT /api/apps/[id] - 更新应用
 */
const updateAppSchema = z.object({
    name: z.string().min(1).max(50).optional(),
    description: z.string().max(200).optional(),
    icon: z.string().optional(),
    type: z.enum(['workflow', 'chatbot', 'agent']).optional(),
    tags: z.array(z.string()).optional(),
    config: z.any().optional(),
})

export async function PUT(request: Request, { params }: { params: { id: string } }) {
    try {
        const userId = getCurrentUserId(request)
        if (!userId) {
            return apiError(ErrorCode.UNAUTHORIZED)
        }

        const { id } = params
        const body = await request.json()
        const result = updateAppSchema.safeParse(body)

        if (!result.success) {
            return apiError(ErrorCode.VALIDATION_ERROR, result.error.issues[0]?.message)
        }

        // 检查应用是否存在且属于当前用户
        const existingApp = await prisma.app.findFirst({
            where: {
                id,
                isDeleted: false,
            },
        })

        if (!existingApp) {
            return apiError(ErrorCode.APP_NOT_FOUND)
        }

        if (existingApp.userId !== userId) {
            return apiError(ErrorCode.APP_NOT_FOUND, '无权修改此应用')
        }

        // 构建更新数据
        const updateData: Record<string, unknown> = {
            version: existingApp.version + 1,
        }

        if (result.data.name !== undefined) updateData.name = result.data.name
        if (result.data.description !== undefined) {
            updateData.description = result.data.description || null
        }
        if (result.data.icon !== undefined) updateData.icon = result.data.icon
        if (result.data.type !== undefined) {
            updateData.type = APP_TYPE_MAP[result.data.type]
        }
        if (result.data.tags !== undefined) updateData.tags = result.data.tags
        if (result.data.config !== undefined) updateData.config = result.data.config

        // 更新应用
        const app = await prisma.app.update({
            where: { id },
            data: updateData as any,
            include: {
                user: {
                    select: { name: true },
                },
            },
        })

        return apiSuccess(
            {
                ...toAppInfo({
                    ...app,
                    type: app.type,
                }),
                updatedAt: formatDate(app.updatedAt),
                createdAt: formatDate(app.createdAt),
                version: app.version,
                config: app.config,
            },
            '应用更新成功'
        )
    } catch (error) {
        return handleApiError(error)
    }
}

/**
 * DELETE /api/apps/[id] - 删除应用（软删除）
 */
export async function DELETE(request: Request, { params }: { params: { id: string } }) {
    try {
        const userId = getCurrentUserId(request)
        if (!userId) {
            return apiError(ErrorCode.UNAUTHORIZED)
        }

        const { id } = params

        // 检查应用是否存在且属于当前用户
        const existingApp = await prisma.app.findFirst({
            where: {
                id,
                isDeleted: false,
            },
        })

        if (!existingApp) {
            return apiError(ErrorCode.APP_NOT_FOUND)
        }

        if (existingApp.userId !== userId) {
            return apiError(ErrorCode.APP_DELETE_FAILED, '无权删除此应用')
        }

        // 软删除
        await prisma.app.update({
            where: { id },
            data: {
                isDeleted: true,
            },
        })

        return apiSuccess({ id }, '应用删除成功')
    } catch (error) {
        return handleApiError(error)
    }
}
