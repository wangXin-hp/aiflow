'use client'

import './login.css'

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form'
import { Input } from '@/components/ui/input'

interface LoginFormValues {
    email: string
    password: string
    name?: string
}

export default function LoginPage() {
    const form = useForm<LoginFormValues>({
        defaultValues: {
            email: '',
            password: '',
            name: '',
        },
    })
    const [inputType, setInputType] = useState<'login' | 'register'>('login')
    const [isLoading, setIsLoading] = useState(false)
    const navigate = useNavigate()

    const handleSubmit = async (values: LoginFormValues) => {
        setIsLoading(true)

        try {
            const response = await fetch(`/api/auth/${inputType}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    email: values.email,
                    password: values.password,
                    name: inputType === 'register' ? values.name || undefined : undefined,
                }),
            })

            if (!response.ok) {
                const data = await response.json()
                throw new Error(data.message || (inputType === 'register' ? '注册失败' : '登录失败'))
            }

            toast.success(inputType === 'register' ? '注册成功' : '登录成功')
            const redirect = new URLSearchParams(window.location.search).get('redirect')
            const target = redirect?.startsWith('/') ? new URL(redirect, window.location.origin) : null
            const destination =
                target?.origin === window.location.origin && target.pathname !== '/account/login'
                    ? target.pathname + target.search + target.hash
                    : '/apps'
            navigate(destination, { replace: true })
        } catch (error) {
            toast.error(error instanceof Error ? error.message : '操作失败，请稍后重试')
        } finally {
            setIsLoading(false)
        }
    }

    return (
        <div className="login-shell">
            <main className="login-card">
                <a className="login-brand" href="/">
                    AI<span>Flow</span>
                    <span className="login-brand-mark" aria-hidden="true">
                        ↗
                    </span>
                </a>
                <p className="login-eyebrow">让想法流动起来</p>
                <h1>{inputType === 'register' ? '创建你的账号' : '欢迎回来'}</h1>
                <p className="login-description">
                    {inputType === 'register' ? '从这里开始，构建你的 AI 工作流。' : '登录 AIFlow，继续探索你的工作空间。'}
                </p>
                <Form {...form}>
                    <form onSubmit={form.handleSubmit(handleSubmit)} className="login-form">
                        {inputType === 'register' && (
                            <FormField
                                control={form.control}
                                name="name"
                                render={({ field }) => (
                                    <FormItem>
                                        <FormLabel>姓名</FormLabel>
                                        <FormControl>
                                            <Input {...field} placeholder="请输入姓名（可选）" disabled={isLoading} />
                                        </FormControl>
                                        <FormMessage />
                                    </FormItem>
                                )}
                            />
                        )}
                        <FormField
                            control={form.control}
                            rules={{
                                required: '请输入邮箱',
                                pattern: {
                                    value: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
                                    message: '请输入有效的邮箱地址',
                                },
                            }}
                            name="email"
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>邮箱</FormLabel>
                                    <FormControl>
                                        <Input {...field} type="email" placeholder="请输入邮箱" disabled={isLoading} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="password"
                            rules={{
                                required: '请输入密码',
                                minLength: inputType === 'register' ? { value: 8, message: '密码至少需要8个字符' } : undefined,
                            }}
                            render={({ field }) => (
                                <FormItem>
                                    <FormLabel>密码</FormLabel>
                                    <FormControl>
                                        <Input {...field} type="password" placeholder="请输入密码" disabled={isLoading} />
                                    </FormControl>
                                    <FormMessage />
                                </FormItem>
                            )}
                        />

                        <Button type="submit" className="login-primary" disabled={isLoading}>
                            {isLoading ? '处理中...' : inputType === 'login' ? '登录' : '注册'}
                        </Button>
                    </form>
                </Form>
                {inputType === 'login' ? (
                    <div className="login-mode">
                        还没有账号？{' '}
                        <Button
                            variant="link"
                            className="login-switch"
                            onClick={() => {
                                form.clearErrors()
                                form.reset()
                                setInputType('register')
                            }}
                        >
                            创建账号
                        </Button>
                    </div>
                ) : (
                    <div className="login-mode">
                        已有账号？{' '}
                        <Button
                            variant="link"
                            className="login-switch"
                            onClick={() => {
                                form.clearErrors()
                                form.reset()
                                setInputType('login')
                            }}
                        >
                            返回登录
                        </Button>
                    </div>
                )}
                <p className="login-footer">连接灵感，让每一步更简单。</p>
            </main>
        </div>
    )
}
