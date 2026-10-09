# Запуск в mainnet

Порядок запуска Unspent в mainnet: что нужно заранее, какие команды в каком порядке, сколько это стоит и что делать в аварии. Весь порядок, кроме реальных транзакций, прогоняется репетицией на форке mainnet: `ops/rehearse.sh` (раздел 7).

**Правило 0.3:** каждый шаг с пометкой **[GO]** отправляет транзакции в mainnet или платные запросы провайдеру. Его делаем только по явному «go» владельца в момент выполнения. Скрипты сами отказываются работать с mainnet без `CONFIRM_MAINNET=yes`.

## 1. Что нужно от владельца

| Что | Зачем | Где используется |
|---|---|---|
| Ключ Anthropic (один или несколько) | инференс | секрет `ANTHROPIC_API_KEYS` на Fly |
| Ключ RPC Helius (или Triton) | все сервисы и сайт; публичный RPC не отдаёт `getProgramAccounts` | `RPC_URL`, `RPC_WS_URL` |
| Ключ Jupiter, тариф Developer (10 RPS) | покупка за любой токен и продажа | `JUPITER_API_KEY` на Vercel |
| Домен сайта и хост API (Q10) | сайт на Vercel, API на Fly | `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_API_HOST` |
| Символ токена кредита (Q1) | метаданные минта, `/token.json` | `TOKEN_SYMBOL` |
| Три кошелька участников мультисигов, лучше аппаратные | голоса 2 из 3 в Squads | `MEMBERS` |
| Аккаунты Fly.io, Vercel, Neon | хостинг (Q11) | — |
| Webhook для алертов (Slack, Telegram-бот и т. п.) | алерты шлюза | `ALERT_WEBHOOK_URL` |
| Тексты Terms и Privacy (раздел 14 брифа) | страницы `/terms`, `/privacy` | — |
| Список стран для геоблока (Q13) | блок, где сервисы провайдера недоступны | ещё не сделан, см. раздел 9 |

## 2. Ключи

Все файлы ключей лежат в `keys/` и никогда не коммитятся.

| Ключ | Что делает | Где живёт |
|---|---|---|
| `keys/unspent-program-keypair.json` | адрес программы `5YSrsYtX6UnSx8KAbiD8RWM7UzNNXU3w5QhxSA2vvfkx`, нужен только при первом деплое | резервная копия офлайн |
| `keys/mainnet-deployer-keypair.json` | платит за деплой, вызывает `initialize`, до передачи — upgrade authority | новый ключ; после запуска остаток SOL выводится, ключ — офлайн |
| `keys/mainnet-credit-mint-keypair.json` | адрес минта; создаётся `launch.ts`, после запуска прав не имеет | резервная копия |
| ключ шлюза | `reserve`, `settle`; держит SOL на ренту резервов и комиссии | секрет `GATEWAY_KEYPAIR` на Fly |
| запасной ключ шлюза | включается мгновенно, если основной скомпрометирован | офлайн; предлагается сразу после запуска (48 ч) |
| ключ proposer | только **создаёт** предложения в мультисигах, голосовать не может | машина оператора |
| 3 ключа участников | голосуют в приложении Squads | у владельца и доверенных лиц |

Казна (`treasury`) — USDC-аккаунт vault'а мультисига `admin`. USDC за потраченные кредиты выводится из него обычным переводом в приложении Squads.

## 3. Стоимость

| Шаг | SOL |
|---|---|
| Замер задержки (200 транзакций) | ≈ 0.002 |
| Два мультисига Squads (комиссии Squads нет, только рент) | ≈ 0.01 |
| Деплой программы: рент 467 КБ | ≈ 3.25 (остаётся в ренте программы) |
| `launch.ts`: минт, метаданные, казна, `initialize` | ≈ 0.03 |
| Запас на ключе шлюза: рент резервов (≈ 0.0013 SOL на идущий запрос, возвращается) и комиссии | 1 |

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
   Шлюз — ровно одна машина: лимиты частоты и очередь расчётов живут в процессе.
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

2. **[GO] Мультисиги Squads.** `admin`: 2 из 3, без time lock. Upgrade authority: 2 из 3, time lock 48 ч. У обоих нет config authority. Адреса сохраняются в `ops/deployments/mainnet-squads.json`.
   ```bash
   export MEMBERS=<участник1>,<участник2>,<участник3> PROPOSER=<proposer>
   CONFIRM_MAINNET=yes PAYER_KEYPAIR=keys/mainnet-deployer-keypair.json pnpm --filter @unspent/ops squads create admin
   CONFIRM_MAINNET=yes PAYER_KEYPAIR=keys/mainnet-deployer-keypair.json TIME_LOCK=172800 pnpm --filter @unspent/ops squads create upgrade
   ```

3. **[GO] Деплой программы, `initialize` и передача права обновления** — одной серией, без пауз. Вызвать `initialize` может только upgrade authority, поэтому перехватить его нельзя.
   ```bash
   solana program deploy target/deploy/unspent.so --program-id keys/unspent-program-keypair.json \
     -k keys/mainnet-deployer-keypair.json --url "$RPC_URL" --with-compute-unit-price 50000 --max-sign-attempts 50
   ADMIN_VAULT=$(node -p "require('./ops/deployments/mainnet-squads.json').admin.vault")
   CONFIRM_MAINNET=yes ADMIN=$ADMIN_VAULT TREASURY_OWNER=$ADMIN_VAULT GATEWAY=<ключ шлюза> \
     TOKEN_SYMBOL=<символ> TOKEN_URI=https://<домен>/token.json pnpm --filter @unspent/ops launch
   CONFIRM_MAINNET=yes pnpm --filter @unspent/ops squads handover
   ```
   Адреса минта, казны и Config пишутся в `ops/deployments/mainnet.json`: этот файл коммитим.

4. **Проверка развёртывания** (только чтение):
   ```bash
   pnpm --filter @unspent/ops verify
   ```
   Должно быть `DEPLOYMENT VERIFIED`. Скрипт проверяет:
   - права программы и `Config`;
   - минт: decimals, mint authority, отсутствие freeze authority;
   - метаданные Metaplex;
   - резерв и хранилище;
   - оба мультисига.

5. **[GO] Шлюз и индексатор.** `fly deploy -c fly.indexer.toml`, затем `fly deploy -c fly.gateway.toml`.
   - Проверить `https://<хост API>/health` и `/v1/models`.
   - Первый живой запрос с кредитами владельца, в бюджете до $5. Сверить его на `/app/usage` и в эксплорере.
   - Сразу предложить запасной ключ шлюза: `squads propose admin propose-gateway-backup <ключ>`. Через 48 ч его применяет `apply_pending` (кто угодно; из этого скрипта — `squads propose admin apply gateway-backup`).

6. **Внутренняя проверка, затем открытие.** Сайт пока работает с `PRELAUNCH=true`.
   - Владелец проходит путь с настоящими кошельками (Phantom, Solflare, Backpack): покупка за USDC и за SOL, депозит, ключ, запрос, вывод.
   - Пул на DEX (Q9, рекомендован Meteora DAMM v2) засевается кредитами, купленными как у всех.
   - Затем `NEXT_PUBLIC_PRELAUNCH=false` и редеплой сайта.

7. **[GO] Заморозка обновлений (Q12)** после проверки на mainnet. После неё обещание обеспечения больше не зависит от мультисига обновлений.
   ```bash
   PROPOSER_KEYPAIR=keys/mainnet-proposer-keypair.json CONFIRM_MAINNET=yes pnpm --filter @unspent/ops squads propose upgrade freeze-upgrades
   ```
   Участники голосуют в приложении Squads; исполнить можно через 48 ч после набора голосов. Затем `EXPECT_FROZEN=1 pnpm --filter @unspent/ops verify`.

## 7. Репетиция на форке

```bash
pnpm --filter @unspent/db devdb &   # локальный Postgres
ops/rehearse.sh                     # или RUN_UI=1 ops/rehearse.sh — плюс браузерный e2e
```

Порядок шагов 2–4 и 7 тот же, что в разделе 6. Мультисиги Squads и метаданные Metaplex — настоящие (форк mainnet), голоса подают локальные ключи. Репетиция дополнительно проверяет:
- пауза и снятие паузы через мультисиг;
- повышение лимита ждёт 48 ч, понижение действует сразу;
- заморозку обновлений нельзя исполнить раньше time lock;
- `shutdown` через мультисиг.

Отличие от mainnet: Surfpool не читает sBPF v3, поэтому на форк ставится копия программы, собранная под v2. Тесты LiteSVM идут на сборке v3.

## 8. Эксплуатация и аварии

Действия админа — это предложения в мультисиге `admin`. Создаёт их proposer, а участники голосуют и исполняют в приложении Squads (порог 2 из 3, без задержки).

Ниже `squads` — это `PROPOSER_KEYPAIR=keys/mainnet-proposer-keypair.json CONFIRM_MAINNET=yes pnpm --filter @unspent/ops squads`.

```bash
squads show admin                                # мультисиг, последние предложения, паузы, ожидающие изменения
squads propose admin pause buy|deposit|gateway   # и unpause
squads propose admin revoke-gateway              # ключ шлюза скомпрометирован
squads propose admin activate-backup-gateway     # мгновенно на заранее одобренный запасной ключ
squads propose admin set-limit max-reservation 20     # понижение — сразу, повышение — через 48 ч
squads propose admin shutdown                    # необратимо: покупка, депозит и новые резервы стоп, выкуп 1:1 открыт
```

| Ситуация | Действие |
|---|---|
| Ключ шлюза скомпрометирован | `activate-backup-gateway` (или `revoke-gateway`); новый ключ в секрет Fly; предложить следующий запасной |
| Подозрительные расчёты | `pause gateway`: новых резервов нет, идущие запросы рассчитываются, вывод и `expire` работают |
| Провайдер отключил ключ | шлюз сам отдаёт 503 без списаний; новый ключ — `fly secrets set ANTHROPIC_API_KEYS=…` (машина перезапустится, оборванные запросы рассчитает сверка) |
| Мало SOL на ключе шлюза | алерт; пополнить с кошелька владельца |
| Закрытие сервиса | `shutdown`; `/app/redeem` выкупает кредиты 1:1 |

Что смотреть каждый день:
- алерты шлюза: отключённый ключ провайдера, застрявшие расчёты, расхождение резерва;
- баланс SOL ключа шлюза;
- страница `/reserve`: покрытие не ниже 100%.

## 9. Открытые вопросы перед открытием

- **Геоблок (Q13)** ещё не сделан. Для сайта — проверка страны в Next (`proxy.ts`, заголовок `x-vercel-ip-country`). Для API — Cloudflare перед хостом API или база GeoIP в шлюзе. Нужен список стран.
- **Тексты Terms и Privacy** от владельца.
- **Символ токена (Q1) и домен (Q10).**
