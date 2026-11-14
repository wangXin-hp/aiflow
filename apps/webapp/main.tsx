import './app/globals.css'

import { createRoot } from 'react-dom/client'
import { createBrowserRouter, RouterProvider } from 'react-router'
import { Toaster } from 'sonner'

import HomePage from '@/app/page'
import WorkflowPage, { loadWorkflow, WorkflowError } from '@/app/workflow/[id]/page'

const router = createBrowserRouter([
    { path: '/', element: <HomePage /> },
    {
        path: '/workflow/:id',
        loader: loadWorkflow,
        element: <WorkflowPage />,
        hydrateFallbackElement: <main className="p-8">正在加载工作流…</main>,
        errorElement: <WorkflowError />,
    },
    { path: '*', element: <main className="p-8">页面不存在</main> },
])

createRoot(document.getElementById('root')!).render(
    <>
        <RouterProvider router={router} />
        <Toaster position="top-center" richColors />
    </>
)
