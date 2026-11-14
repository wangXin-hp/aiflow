import { join } from 'node:path'

import { config } from 'dotenv'
import { defineConfig, env } from 'prisma/config'

config({ path: ['.env.local', '.env'] })

export default defineConfig({
    schema: join(import.meta.dirname, 'prisma', 'schema.prisma'),
    datasource: {
        url: env('DATABASE_URL'),
    },
})
