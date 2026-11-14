import { randomUUID } from 'node:crypto'

import { z } from 'zod'

import { Prisma } from '@/app/generated/prisma/client'
import { apiError, apiSuccess, ErrorCode, handleApiError } from '@/lib/api-response'
import { generateToken, setAuthCookie } from '@/lib/auth'
import { hashPassword } from '@/lib/password'
import { prisma } from '@/lib/prisma'

const registerSchema = z.object({
    email: z.email('请输入有效的邮箱地址'),
    password: z.string().min(8, '密码至少需要8个字符'),
    name: z.string().min(1, '请输入姓名').optional(),
})

export async function POST(request: Request) {
    try {
        const body = await request.json()

        // 验证输入
        const result = registerSchema.safeParse(body)
        if (!result.success) {
            return apiError(ErrorCode.VALIDATION_ERROR, result.error.issues[0].message)
        }

        const { email, password, name } = result.data

        // 检查邮箱是否已存在
        const existingUser = await prisma.user.findUnique({
            where: { email },
        })

        if (existingUser) {
            return apiError(ErrorCode.EMAIL_ALREADY_EXISTS)
        }

        // 加密密码
        const hashedPassword = await hashPassword(password)

        const id = randomUUID()
        const token = generateToken(id)

        // 创建用户
        const user = await prisma.user.create({
            data: {
                id,
                email,
                password: hashedPassword,
                name: name || null,
            },
            select: {
                id: true,
            },
        })

        return setAuthCookie(apiSuccess({ userId: user.id }, '注册成功'), token)
    } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            return apiError(ErrorCode.EMAIL_ALREADY_EXISTS)
        }
        return handleApiError(error)
    }
}
