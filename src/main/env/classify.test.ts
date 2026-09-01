import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, compareEnvironments, identifyEnvFile, shouldMask } from './classify.ts'

test('值长得像真 Key 时判为 high，压过命名规则', () => {
  // 变量名毫无提示，但值本身是可识别的凭据
  assert.deepEqual(classify('FOO', 'sk-proj-abcdefghijklmnopqrstuvwxyz012345'), {
    valueType: 'secret',
    sensitivity: 'high'
  })
  assert.equal(classify('X', 'ghp_abcdefghijklmnopqrstuvwxyz0123').sensitivity, 'high')
  assert.equal(classify('X', 'AKIAIOSFODNN7EXAMPLE').sensitivity, 'high')
  assert.equal(classify('CERTIFICATE', '-----BEGIN RSA PRIVATE KEY-----\nMII').sensitivity, 'high')
  assert.equal(
    classify('X', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc').sensitivity,
    'high'
  )
})

test('带凭据的连接串判为 secret 而不是 url', () => {
  const result = classify('DATABASE_URL', 'postgres://vault_user:hunter2@db.internal:5432/app')
  assert.deepEqual(result, { valueType: 'secret', sensitivity: 'high' })
})

test('不带凭据的连接串仍然只是 url', () => {
  assert.equal(classify('API_URL', 'https://api.example.com/v1').valueType, 'url')
})

test('名字涉密时判为 sensitive', () => {
  assert.deepEqual(classify('OPENAI_API_KEY', 'whatever'), {
    valueType: 'secret',
    sensitivity: 'sensitive'
  })
  assert.equal(classify('NEXTAUTH_SECRET', 'abc').sensitivity, 'sensitive')
  assert.equal(classify('DB_PASSWORD', 'abc').sensitivity, 'sensitive')
  assert.equal(classify('SENTRY_DSN', 'abc').sensitivity, 'sensitive')
})

test('词边界：MONKEY 不因为含 KEY 就被判涉密', () => {
  assert.equal(classify('MONKEY', 'banana').sensitivity, 'normal')
  assert.equal(classify('KEYBOARD_LAYOUT', 'us').sensitivity, 'normal')
})

test('空值不升级敏感等级', () => {
  // `API_KEY=` 是占位符，掩码它只会碍事
  assert.equal(classify('API_KEY', '').sensitivity, 'normal')
  assert.equal(classify('API_KEY', '   ').sensitivity, 'normal')
})

test('前端公开前缀不按 secret 处理', () => {
  assert.equal(classify('NEXT_PUBLIC_API_KEY', 'pk_live_visible').sensitivity, 'normal')
  assert.equal(classify('VITE_APP_TOKEN', 'public-token').sensitivity, 'normal')
})

test('但公开前缀里塞了真 Key 依然要报出来', () => {
  // 这是个真问题：它会被打包进前端产物
  assert.equal(
    classify('NEXT_PUBLIC_KEY', 'sk-proj-abcdefghijklmnopqrstuvwxyz012345').sensitivity,
    'high'
  )
})

test('基础类型判断', () => {
  assert.equal(classify('PORT', '3000').valueType, 'number')
  assert.equal(classify('RATE', '-1.5').valueType, 'number')
  assert.equal(classify('ENABLE_CACHE', 'true').valueType, 'boolean')
  assert.equal(classify('DEBUG', 'OFF').valueType, 'boolean')
  assert.equal(classify('LOG_LEVEL', 'debug').valueType, 'text')
  assert.equal(classify('EMPTY', '').valueType, 'text')
})

test('掩码规则', () => {
  assert.equal(shouldMask('normal'), false)
  assert.equal(shouldMask('sensitive'), true)
  assert.equal(shouldMask('high'), true)
})

// ---------------------------------------------------------------------------

test('文件名到环境的映射', () => {
  assert.deepEqual(identifyEnvFile('.env'), { environment: 'default', isTemplate: false })
  assert.deepEqual(identifyEnvFile('.env.local'), { environment: 'local', isTemplate: false })
  assert.deepEqual(identifyEnvFile('.env.production'), {
    environment: 'production',
    isTemplate: false
  })
})

test('.local 覆盖层归到它覆盖的那个环境', () => {
  // 分成两个环境会让同一个变量出现两次却说不清优先级
  assert.deepEqual(identifyEnvFile('.env.development.local'), {
    environment: 'development',
    isTemplate: false
  })
  assert.deepEqual(identifyEnvFile('.env.test.local'), { environment: 'test', isTemplate: false })
})

test('模板文件被标出来', () => {
  assert.deepEqual(identifyEnvFile('.env.example'), { environment: 'example', isTemplate: true })
  assert.equal(identifyEnvFile('.env.sample')?.isTemplate, true)
  assert.equal(identifyEnvFile('.env.template')?.isTemplate, true)
})

test('非 .env 文件返回 null', () => {
  assert.equal(identifyEnvFile('env'), null)
  assert.equal(identifyEnvFile('.environment'), null)
  assert.equal(identifyEnvFile('package.json'), null)
  assert.equal(identifyEnvFile('.env.'), null)
})

test('环境排序：常用的在前，其余按字母序', () => {
  const sorted = ['zeta', 'production', 'alpha', 'default', 'test'].sort(compareEnvironments)
  assert.deepEqual(sorted, ['default', 'test', 'production', 'alpha', 'zeta'])
})
