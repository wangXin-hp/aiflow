import { apiError, apiSuccess, ErrorCode, handleApiError } from '@/lib/api-response'
import { getCurrentUserId } from '@/lib/auth'
import { prisma } from '@/lib/prisma'

interface UserResponse {
    id: string
    email: string
    name: string | null
    avatar: string | null
    emailVerified: Date | null
    createdAt: Date
}

export async function GET(request: Request) {
    try {
        const userId = getCurrentUserId(request)

        if (!userId) {
            return apiError(ErrorCode.UNAUTHORIZED)
        }

        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: {
                id: true,
                email: true,
                name: true,
                avatar: true,
                emailVerified: true,
                createdAt: true,
            },
        })

        if (!user) {
            return apiError(ErrorCode.USER_NOT_FOUND)
        }

        return apiSuccess<{ user: UserResponse }>({ user })
    } catch (error) {
        return handleApiError(error)
    }
}
