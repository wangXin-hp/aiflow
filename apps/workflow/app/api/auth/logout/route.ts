import { apiSuccess } from '@/lib/api-response'
import { setAuthCookie } from '@/lib/auth'

export function POST() {
    return setAuthCookie(apiSuccess({ message: '已成功登出' }), '')
}
