import { parse, serialize } from 'hono/utils/cookie'
import jwt from 'jsonwebtoken'

const TOKEN_NAME = 'auth-token'
const TOKEN_MAX_AGE = 60 * 60 * 24 * 7

export function generateToken(userId: string): string {
    return jwt.sign({ userId }, process.env.JWT_SECRET!, { expiresIn: '7d' })
}

export function getCurrentUserId(request: Request): string | null {
    const token = parse(request.headers.get('cookie') ?? '', TOKEN_NAME)[TOKEN_NAME]
    if (!token) return null

    try {
        const payload = jwt.verify(token, process.env.JWT_SECRET!)
        return typeof payload !== 'string' && typeof payload.userId === 'string' ? payload.userId : null
    } catch {
        return null
    }
}

export function setAuthCookie(response: Response, token: string) {
    response.headers.append(
        'Set-Cookie',
        serialize(TOKEN_NAME, token, {
            httpOnly: true,
            secure: process.env.NODE_ENV === 'production',
            sameSite: 'Lax',
            maxAge: token ? TOKEN_MAX_AGE : 0,
            path: '/',
        })
    )
    return response
}
