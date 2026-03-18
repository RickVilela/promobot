# ⚡ PromoBot — Mercado Livre + Telegram

Bot que busca promoções automaticamente no Mercado Livre e posta nos seus canais do Telegram com seus links de afiliado.

---

## Funcionalidades

- 🔍 **Scraping automático** — busca ofertas do dia, por palavras-chave e por categoria
- 🔗 **Link de afiliado automático** — substitui todos os links pela sua tag de afiliado ML
- 📡 **Multi-canal Telegram** — posta em vários canais com filtros por categoria
- 🖼️ **Preview com imagem** — envia a foto do produto junto da promoção
- 📋 **Histórico completo** — evita repostar a mesma promoção
- 🌐 **Painel web** — gerencie tudo via browser em `http://localhost:3000`

---

## Instalação

### 1. Pré-requisitos
- Node.js 18+ 
- npm

### 2. Instalar dependências
```bash
npm install
```

### 3. Configurar variáveis de ambiente
```bash
cp .env.example .env
```

Edite o `.env` com seus dados:

```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrSTUvwxYZ
TELEGRAM_CHANNEL_IDS=-1001234567890
ML_AFFILIATE_TAG=seutag-55
MIN_DISCOUNT_PERCENT=15
SCRAPE_INTERVAL_MINUTES=30
SEARCH_KEYWORDS=smartphone,notebook,tv,headphone
ML_CATEGORIES=eletronicos,informatica,eletrodomesticos
```

### 4. Iniciar
```bash
npm start
```

Acesse o painel: **http://localhost:3000**

---

## Configuração do Telegram

### Criar o bot
1. Abra o Telegram e busque por **@BotFather**
2. Envie `/newbot` e siga as instruções
3. Anote o **token** gerado (ex: `1234567890:ABCdef...`)
4. Cole no `.env` como `TELEGRAM_BOT_TOKEN`

### Adicionar o bot ao canal
1. Abra seu canal no Telegram
2. Vá em **Configurações → Administradores → Adicionar administrador**
3. Busque pelo username do seu bot e adicione com permissão de **enviar mensagens**

### Obter o ID do canal
1. Adicione **@userinfobot** ao canal
2. Envie qualquer mensagem → ele responde com o ID (começa com `-100...`)
3. Cole no `.env` como `TELEGRAM_CHANNEL_IDS`

---

## Programa de Afiliados ML

1. Acesse [mercadolivre.com.br/afiliados](https://www.mercadolivre.com.br/afiliados)
2. Cadastre-se no programa
3. Crie uma campanha e anote sua **tag** (ex: `seutag-55`)
4. Cole no `.env` como `ML_AFFILIATE_TAG`

O bot adiciona automaticamente `?mt=seutag-55` em todos os links postados.

---

## Painel Web

Acesse `http://localhost:3000` para:

- **Dashboard** — estatísticas e últimas promoções
- **Pendentes** — promoções encontradas aguardando postagem (aprovar/ignorar manualmente)
- **Histórico** — todas as promoções já processadas
- **Canais** — gerenciar canais Telegram com filtros
- **Configuração** — testar conexão e ver variáveis

---

## Deploy em servidor (produção)

### Railway (recomendado — grátis)
```bash
# Instale o CLI
npm install -g @railway/cli

# Login e deploy
railway login
railway new
railway up

# Configure as variáveis no dashboard do Railway
```

### Render
1. Crie conta em [render.com](https://render.com)
2. Conecte o repositório
3. Configure as variáveis de ambiente no painel
4. Deploy automático

### VPS com PM2
```bash
npm install -g pm2
pm2 start src/index.js --name promobot
pm2 save
pm2 startup
```

---

## Estrutura do projeto

```
promobot/
├── src/
│   ├── index.js          # Entry point
│   ├── scheduler.js      # Cron + orquestração
│   ├── scraper/
│   │   └── mlScraper.js  # Scraping do Mercado Livre
│   ├── bot/
│   │   └── telegram.js   # Envio para Telegram
│   ├── db/
│   │   └── database.js   # SQLite (better-sqlite3)
│   └── web/
│       └── server.js     # Painel web (Express)
├── data/
│   └── promobot.db       # Banco de dados (criado automaticamente)
├── .env                  # Suas configurações (não commitar!)
├── .env.example          # Template de configuração
└── package.json
```

---

## Notas importantes

- O scraping respeita intervalos entre requisições para não ser bloqueado
- Promoções duplicadas são automaticamente ignoradas (pelo ID do produto ML)
- Imagens são enviadas diretamente pelo Telegram via URL (sem baixar localmente)
- O banco de dados SQLite é criado automaticamente na primeira execução
- Logs são exibidos no console em tempo real
