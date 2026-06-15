import 'dotenv/config' // .env.local を読み込む（dotenv は devDependencies）

const url = process.env.PING_URL ?? 'http://127.0.0.1:3000/api/ping'
const secret = process.env.PING_SECRET ?? 'test-secret-for-phase1'

const noAuth = await fetch(url)
const noAuthBody = await noAuth.text()
console.log('NO_AUTH status=' + noAuth.status + ' body=' + noAuthBody)

const withAuth = await fetch(url, {
  headers: { Authorization: 'Bearer ' + secret },
})
const withAuthBody = await withAuth.text()
console.log('WITH_AUTH status=' + withAuth.status + ' body=' + withAuthBody)
