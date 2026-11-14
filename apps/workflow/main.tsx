import './app/globals.css'

import { createRoot } from 'react-dom/client'
import { createBrowserRouter, type LoaderFunctionArgs, Navigate, Outlet, redirect, RouterProvider } from 'react-router'

import AppsPage from '@/app/(main)/apps/page'
import MainLayout from '@/app/(main)/layout'
import LoginPage from '@/app/account/login/page'
import AppLayout from '@/app/app/[id]/layout'
import KnowledgeDetailLayout from '@/app/knowledge/[id]/layout'
import KnowledgeLayout from '@/app/knowledge/layout'
import KnowledgePage from '@/app/knowledge/page'
import ToolsLayout from '@/app/tools/layout'
import ToolsPage from '@/app/tools/page'
import { Toaster } from '@/components/ui/sonner'

async function requireSession({ request }: LoaderFunctionArgs) {
    const response = await fetch('/api/auth/me', { signal: request.signal, cache: 'no-store' })
    if (response.status === 401 || response.status === 404) {
        const url = new URL(request.url)
        throw redirect(`/account/login?${new URLSearchParams({ redirect: url.pathname + url.search })}`)
    }
    if (!response.ok) throw response
    return null
}

const router = createBrowserRouter([
    { path: '/account/login', element: <LoginPage /> },
    {
        loader: requireSession,
        hydrateFallbackElement: <main className="p-8">正在加载…</main>,
        errorElement: <main className="p-8">加载失败，请刷新页面重试。</main>,
        children: [
            { index: true, element: <Navigate to="/apps" replace /> },
            {
                path: 'apps',
                element: (
                    <MainLayout>
                        <AppsPage />
                    </MainLayout>
                ),
            },
            {
                path: 'app/:id',
                element: (
                    <AppLayout>
                        <Outlet />
                    </AppLayout>
                ),
                children: [
                    { index: true, element: <Navigate to="workflow" replace /> },
                    { path: 'workflow', lazy: async () => ({ Component: (await import('@/app/app/[id]/workflow/page')).default }) },
                    { path: 'api', lazy: async () => ({ Component: (await import('@/app/app/[id]/api/page')).default }) },
                    {
                        path: 'execution-logs',
                        lazy: async () => ({ Component: (await import('@/app/app/[id]/execution-logs/page')).default }),
                    },
                    { path: 'monitoring', lazy: async () => ({ Component: (await import('@/app/app/[id]/monitoring/page')).default }) },
                ],
            },
            {
                path: 'knowledge',
                element: (
                    <KnowledgeLayout>
                        <Outlet />
                    </KnowledgeLayout>
                ),
                children: [
                    { index: true, element: <KnowledgePage /> },
                    {
                        path: ':id',
                        element: (
                            <KnowledgeDetailLayout>
                                <Outlet />
                            </KnowledgeDetailLayout>
                        ),
                        children: [
                            { index: true, element: <Navigate to="documents" replace /> },
                            {
                                path: 'documents',
                                lazy: async () => ({ Component: (await import('@/app/knowledge/[id]/documents/page')).default }),
                            },
                            {
                                path: 'search',
                                lazy: async () => ({ Component: (await import('@/app/knowledge/[id]/search/page')).default }),
                            },
                            {
                                path: 'settings',
                                lazy: async () => ({ Component: (await import('@/app/knowledge/[id]/settings/page')).default }),
                            },
                        ],
                    },
                ],
            },
            {
                path: 'tools',
                element: (
                    <ToolsLayout>
                        <ToolsPage />
                    </ToolsLayout>
                ),
            },
            { path: '*', element: <main className="p-8">页面不存在</main> },
        ],
    },
])

createRoot(document.getElementById('root')!).render(
    <>
        <RouterProvider router={router} />
        <Toaster richColors position="top-center" />
    </>
)
