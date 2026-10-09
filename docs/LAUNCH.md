# Запуск в mainnet

Порядок запуска Unspent в mainnet: что нужно заранее, какие команды в каком порядке, сколько это стоит и что делать в аварии. Весь порядок, кроме реальных транзакций, прогоняется репетицией на форке mainnet: `ops/rehearse.sh` (раздел 7).

**Решение владельца, 2026-10-10: без мультисига.** Один кошелёк владельца (лучше Ledger через Phantom) — это `admin` программы, upgrade authority до заморозки и владелец казны. `admin` в программе не меняется никогда, поэтому кошелёк выбирается раз и навсегда. Все действия админа — на скрытой странице `/app/admin`, подпись в кошельке. Задержка `admin_delay` (48 ч) для опасных изменений остаётся в самой программе.

**Правило 0.3:** каждый шаг с пометкой **[GO]** отправляет транзакции в mainnet или платные запросы провайдеру. Его делаем только по явному «go» владельца в момент выполнения. Скрипты сами отказываются работать с mainnet без `CONFIRM_MAINNET=yes`.

## 1. Что нужно от владельца

Значения владелец вписывает в `.env.mainnet` в корне (в `.gitignore`, в образ и на Vercel не попадает), не в чат.

| Что | Зачем | Где используется |
|---|---|---|
| Ключ Anthropic (один или несколько) | инференс | секрет `ANTHROPIC_API_KEYS` на Fly |
| Ключ RPC Helius (или Triton) | все сервисы и сайт; публичный RPC не отдаёт `getProgramAccounts` | `RPC_URL`, `RPC_WS_URL` |
| Ключ Jupiter, тариф Developer (10 RPS) | покупка за любой токен и продажа | `JUPITER_API_KEY` на Vercel |
| Домен сайта и хост API (Q10) | сайт на Vercel, API на Fly | `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_API_HOST` |
| Символ токена кредита (Q1) | метаданные минта, `/token.json` | `TOKEN_SYMBOL` |
| Адрес кошелька админа, лучше Ledger | `admin`, upgrade authority, казна, метаданные токена | `ADMIN` |
| Аккаунты Fly.io, Vercel, Neon | хостинг (Q11) | — |
| Webhook для алертов: Discord, Slack или Telegram (`https://api.telegram.org/bot<токен>/sendMessage?chat_id=<id>`) | алерты шлюза, приходят текстом | `ALERT_WEBHOOK_URL` |
| Юрлицо, контактный email, применимое право | черновики Terms и Privacy уже на сайте, эти три значения подставляются | `LEGAL_ENTITY`, `CONTACT_EMAIL`, `GOVERNING_LAW` на Vercel |

## 2. Ключи

Все файлы ключей лежат в `keys/` и никогда не коммитятся.

| Ключ | Что делает | Где живёт |
|---|---|---|
| `keys/unspent-program-keypair.json` | адрес программы `5YSrsYtX6UnSx8KAbiD8RWM7UzNNXU3w5QhxSA2vvfkx`, нужен только при первом деплое | резервная копия офлайн |
| `keys/mainnet-deployer-keypair.json` | платит за деплой, вызывает `initialize`, до передачи — upgrade authority | новый ключ; после запуска остаток SOL выводится, ключ — офлайн |
| `keys/mainnet-credit-mint-keypair.json` | адрес минта; создаётся `launch.ts`, после запуска прав не имеет | резервная копия |
| ключ шлюза | `reserve`, `settle`; держит SOL на ренту резервов и комиссии | секрет `GATEWAY_KEYPAIR` на Fly |
| запасной ключ шлюза | включается мгновенно, если основной скомпрометирован | офлайн; предлагается сразу после запуска (48 ч) |
| кошелёк админа | все действия админа на `/app/admin`, upgrade authority до заморозки; его seed-фраза — главный секрет проекта | у владельца, ключ никогда не попадает на сервер |

Казна (`treasury`) — USDC-аккаунт кошелька админа: USDC за потраченные кредиты сразу приходит владельцу.

## 3. Стоимость

| Шаг | SOL |
|---|---|
| Замер задержки (200 транзакций) | ≈ 0.002 |
| Деплой программы: рент 467 КБ | ≈ 3.25 (остаётся в ренте программы) |
| `launch.ts`: минт, метаданные, казна, `initialize`, передача upgrade authority | ≈ 0.03 |
| Запас на ключе шлюза: рент резервов (≈ 0.0013 SOL на идущий запрос, возвращается) и комиссии | 1 |
| Кошелёк админа: комиссии действий на `/app/admin` | ≈ 0.02 |

На кошельке деплоера нужно около **3.4 SOL**. Буфер деплоя отдаёт свои SOL деплоеру до оплаты аккаунта программы, поэтому второй раз рент не нужен: проверено деплоем на форке с балансом «рент + 0.03 SOL».

## 4. Инфраструктура (без транзакций)

1. **Neon:** проект и база `unspent`. Шлюзу и индексатору — прямой URL (`DATABASE_URL`), сайту на Vercel — pooled URL. Миграции применяют шлюз и индексатор при старте, под advisory lock.
2. **Helius:** ключ; `RPC_URL=https://mainnet.helius-rpc.com/?api-key=…`, `RPC_WS_URL=wss://mainnet.helius-rpc.com/?api-key=…`.
3. **Fly.io:** приложения `unspent-gateway` и `unspent-indexer` из корня репозитория, конфиги `fly.gateway.toml` и `fly.indexer.toml`, один образ (`Dockerfile`). Секреты:
   ```bash
   fly apps create unspent-gateway && fly apps create unspent-indexer
   fly secrets set -a unspent-indexer DATABASE_URL=… RPC_URL=… RPC_WS_URL=…
   fly secrets set -a unspent-gateway DATABASE_URL=… RPC_URL=… GATEWAY_KEYPAIR="$(cat keys/mainnet-gateway-keypair.json)" \
     ANTHROPIC_API_KEYS=… ALERT_WEBHOOK_URL=… NEXT_PUBLIC_SITE_URL=https://<домен>
   fly certs add <хост API> -a unspent-gateway   # затем CNAME у регистратора
   ```
   Шлюз — ровно одна машина: лимиты частоты и очередь расчётов живут в процессе. Образ при сборке скачивает базу «IP → страна» DB-IP для геоблока; раз в месяц образ стоит пересобирать (`fly deploy`), чтобы база была свежей.
4. **Vercel:** проект с Root Directory `apps/web`, переменная `ENABLE_EXPERIMENTAL_COREPACK=1` (pnpm 12 из `packageManager`). Переменные окружения:

   | Переменная | Значение |
   |---|---|
   | `NEXT_PUBLIC_SOLANA_NETWORK` | `mainnet` |
   | `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_API_HOST`, `NEXT_PUBLIC_X_URL` | домен, хост API, ссылка на X |
   | `NEXT_PUBLIC_PRELAUNCH` | `true` до открытия (раздел 6, шаг 6) |
   | `NEXT_PUBLIC_PROJECT_TOKEN_CA` | пусто (токен проекта вне ТЗ) |
   | `SESSION_SECRET` | `openssl rand -base64 32` |
   | `DATABASE_URL` | pooled URL Neon |
   | `RPC_URL` | Helius |
   | `JUPITER_API_KEY` | ключ Jupiter |
   | `TOKEN_SYMBOL` | символ кредита (тот же, что в `launch.ts`) |
   | `LEGAL_ENTITY`, `CONTACT_EMAIL`, `GOVERNING_LAW` | для Terms и Privacy; без них продакшен-сборка открытого сайта не пройдёт |

   Сайт можно выложить сразу в режиме `PRELAUNCH=true`: Docs открыты, `/app` закрыт.

## 5. Сборка программы

```bash
anchor build                     # sBPF v3, target/deploy/unspent.so
shasum -a 256 target/deploy/unspent.so
cargo test -p unspent --release  # 87 тестов LiteSVM
```

Для открытия кода (Q12) стоит сделать воспроизводимую сборку `solana-verify build` на машине с Docker и после деплоя опубликовать верификацию, чтобы эксплореры показывали «verified». Это не аудит и так не называется.

## 6. Запуск по шагам

Переменные для всех команд `ops`:

```bash
export NETWORK=mainnet RPC_URL=https://mainnet.helius-rpc.com/?api-key=… WS_URL=wss://mainnet.helius-rpc.com/?api-key=…
```

1. **[GO] Замер задержки `reserve`** (4.1 п. 8). Показывает, сколько ждёт каждый запрос до первого токена.
   ```bash
   CONFIRM_MAINNET=yes PAYER_KEYPAIR=keys/mainnet-deployer-keypair.json N=200 pnpm --filter @unspent/ops latency
   ```
   Если p95 заметно больше 3 с — обсуждаем резерв на пачку запросов (раздел 15 брифа).

2. **[GO] Деплой программы, `initialize` и передача права обновления** — одной серией, без пауз. Вызвать `initialize` может только upgrade authority, поэтому перехватить его нельзя. `launch.ts` сразу после `initialize` передаёт upgrade authority кошельку админа: у деплоера не остаётся прав.
   ```bash
   solana program deploy target/deploy/unspent.so --program-id keys/unspent-program-keypair.json \
     -k keys/mainnet-deployer-keypair.json --url "$RPC_URL" --with-compute-unit-price 50000 --max-sign-attempts 50
   CONFIRM_MAINNET=yes ADMIN=<кошелёк админа> GATEWAY=<ключ шлюза> \
     TOKEN_SYMBOL=<символ> TOKEN_URI=https://<домен>/token.json pnpm --filter @unspent/ops launch
   ```
   Казна по умолчанию — USDC-аккаунт кошелька админа (`TREASURY_OWNER` можно задать отдельно). Адреса минта, казны и Config пишутся в `ops/deployments/mainnet.json`: этот файл коммитим.

3. **Проверка развёртывания** (только чтение):
   ```bash
   pnpm --filter @unspent/ops verify
   ```
   Должно быть `DEPLOYMENT VERIFIED`. Скрипт проверяет:
   - upgrade authority, `admin`, владелец казны и update authority метаданных — кошелёк админа;
   - `Config` и лимиты по умолчанию;
   - минт: decimals, mint authority, отсутствие freeze authority;
   - метаданные Metaplex;
   - резерв и хранилище.

4. **[GO] Шлюз и индексатор.** `fly deploy -c fly.indexer.toml`, затем `fly deploy -c fly.gateway.toml`.
   - Проверить `https://<хост API>/health` и `/v1/models`.
   - Первый живой запрос с кредитами владельца, в бюджете до $5. Сверить его на `/app/usage` и в эксплорере.
   - Сразу предложить запасной ключ шлюза: `/app/admin` → Gateway key → Propose backup key. Через 48 ч там же появится Apply.

5. **Внутренняя проверка, затем открытие.** Публичный сайт пока работает с `PRELAUNCH=true` (`/app`, включая `/app/admin`, закрыт), поэтому проверка идёт на локальной копии сайта с mainnet-настройками.
   - Владелец проходит путь с настоящими кошельками (Phantom, Solflare, Backpack): покупка за USDC и за SOL, депозит, ключ, запрос, вывод.
   - Пул на DEX (Q9, рекомендован Meteora DAMM v2) засевается кредитами, купленными как у всех.
   - Затем `NEXT_PUBLIC_PRELAUNCH=false` и редеплой сайта.

6. **[GO] Заморозка обновлений (Q12)** после проверки на mainnet: `/app/admin` → Program upgrades → Freeze upgrades forever (ввести `FREEZE`). После неё код программы нельзя изменить никому, и обещание обеспечения больше не зависит от ключа владельца. Затем `EXPECT_FROZEN=1 pnpm --filter @unspent/ops verify`.

   До заморозки исправление программы: оператор пишет новый код в буфер (`solana program write-buffer`), передаёт буфер кошельку админа (`solana program set-buffer-authority <буфер> --new-buffer-authority <админ>`), владелец подписывает на `/app/admin` → Upgrade the program from the buffer.

## 7. Репетиция на форке

```bash
pnpm --filter @unspent/db devdb &   # локальный Postgres
ops/rehearse.sh                     # или RUN_UI=1 ops/rehearse.sh — плюс пользовательский браузерный e2e
```

Шаги 2–3 и 6 из раздела 6 идут тем же порядком; метаданные Metaplex настоящие (форк mainnet), кошелёк админа заменяет локальный ключ `keys/localnet-admin-keypair.json`. Действия админа выполняются в настоящем браузере на `/app/admin` (`tests/e2e/admin.ts`):
- другой кошелёк страницу не видит (404);
- пауза и снятие паузы;
- повышение лимита ждёт 48 ч, затем Apply; понижение действует сразу;
- запасной ключ шлюза предлагается и отменяется;
- заморозка обновлений;
- `shutdown`;
- axe и ширина 390 px.

Если публичный RPC форка сбоит («Failed to fetch accounts from remote»), запускать с `SURF_RPC_URL=https://solana-rpc.publicnode.com`.

Отличие от mainnet: Surfpool не читает sBPF v3, поэтому на форк ставится копия программы, собранная под v2. Тесты LiteSVM идут на сборке v3.

## 8. Эксплуатация и аварии

Все действия админа — на `/app/admin` (ссылка Admin видна только кошельку админа), каждое подписывается в кошельке. Если сайт недоступен, та же страница работает в локальной копии сайта (`pnpm --filter @unspent/web dev` с mainnet-настройками).

| Ситуация | Действие на `/app/admin` |
|---|---|
| Ключ шлюза скомпрометирован | Switch to the backup key (или Revoke the gateway key); новый ключ в секрет Fly; предложить следующий запасной |
| Подозрительные расчёты | Pause API requests: новых резервов нет, идущие запросы рассчитываются, вывод и `expire` работают |
| Провайдер отключил ключ | шлюз сам отдаёт 503 без списаний; новый ключ — `fly secrets set ANTHROPIC_API_KEYS=…` (машина перезапустится, оборванные запросы рассчитает сверка) |
| Мало SOL на ключе шлюза | алерт; пополнить с кошелька владельца |
| Утечка seed-фразы кошелька админа | Freeze upgrades forever сразу, если ещё не заморожено; затем решать, закрывать ли сервис. Сменить `admin` в программе нельзя |
| Закрытие сервиса | Shut down Unspent; `/app/redeem` выкупает кредиты 1:1 |

Что смотреть каждый день:
- алерты шлюза: отключённый ключ провайдера, застрявшие расчёты, расхождение резерва;
- баланс SOL ключа шлюза;
- страница `/reserve`: покрытие не ниже 100%.

## 9. Перед открытием

- **Геоблок (Q13) сделан** по [списку стран Anthropic](https://www.anthropic.com/supported-countries) (`packages/shared/src/regions.ts`, 185 стран):
  - сайт закрывает `/app` и свои API по заголовку страны от Vercel;
  - шлюз отвечает `403 region_not_supported` по IP (база DB-IP);
  - главная, Docs, Terms и Privacy открыты всем;
  - Украина разрешена целиком: база по странам не различает регионы, исключённые Anthropic.

  Список стоит сверять со страницей Anthropic перед запуском.
- **Terms и Privacy** — черновики на сайте. Их нужно прочитать, лучше показать юристу, и задать `LEGAL_ENTITY`, `CONTACT_EMAIL`, `GOVERNING_LAW`.
- **Символ токена (Q1) и домен (Q10).**
