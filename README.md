# Nuxt + Supabase Project

A web application built with Nuxt 3, Nuxt UI, and Supabase.

## Prerequisites

- [asdf](https://asdf-vm.com/) version manager
- [Docker](https://www.docker.com/) and Docker Compose
- Node.js 23.9.0 (managed via asdf)

## Getting Started

### 1. Clone the repository

```bash
git clone [repository-url]
cd [repository-name]
```

### 2. Install Node.js using asdf

```bash
asdf install
```

### 3. Install dependencies

```bash
npm install
```

### 4. Set up Supabase

1. Navigate to the Supabase directory:

    ```bash
    cd supabase
    ```

2. Create your environment file:

    ```bash
    cp .env.example .env
    ```

3. Update the following required variables in `.env`:

    - `POSTGRES_PASSWORD`
    - `JWT_SECRET`
    - `DASHBOARD_PASSWORD`
    - `VAULT_ENC_KEY`

4. Start Supabase services:

    ```bash
    docker compose up -d
    ```

5. Return to the project root:

    ```bash
    cd ..
    ```

### 5. Configure environment variables

1. Create your root environment file:

    ```bash
    cp .env.example .env
    ```

2. Set `SUPABASE_KEY` in `.env` to the `ANON_KEY` value from `supabase/.env`

### 6. Start the development server

```bash
npm run dev
```

The application will be available at `http://localhost:3000`

## Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build the application
- `npm run generate` - Generate static files
- `npm run preview` - Preview the build
- `npm run postinstall` - Run Nuxt preparation steps
- `npm run lint` - Run ESLint checks
- `npm run lint:fix` - Fix ESLint issues

## Development Resources

- [Nuxt 3 Documentation](https://nuxt.com/docs)
- [Supabase Documentation](https://supabase.com/docs)
- [Vue 3 Documentation](https://vuejs.org/guide/introduction.html)

## Project Structure

- `/app` - Main application directory
    - `/assets` - Project assets (images, videos, CSS)
    - `/components` - Vue components
    - `/pages` - Application routes
    - `/types` - TypeScript type definitions
- `/server` - Server-side TypeScript configuration
- `/supabase` - Supabase configuration and Docker setup
- `/public` - Static assets
