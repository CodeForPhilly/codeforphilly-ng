<template>
  <UContainer class="py-12">
    <div class="max-w-2xl mx-auto space-y-8">
      <!-- Header -->
      <div class="text-center">
        <h1 class="text-3xl font-bold mb-4">GitHub OAuth Test Page</h1>
        <p class="text-gray-600">Test GitHub login functionality without Supabase</p>
      </div>

      <!-- Login Button -->
      <div v-if="!isLoading && !userData" class="text-center">
        <UButton
          color="primary"
          size="lg"
          icon="i-lucide-github"
          label="Login with GitHub"
          @click="handleLogin"
        />
      </div>

      <!-- Loading State -->
      <div v-if="isLoading" class="text-center py-12">
        <UProgress class="mx-auto" indeterminate />
        <p class="mt-2 text-gray-600">{{ loadingMessage }}</p>
      </div>

      <!-- Error Display -->
      <UAlert
        v-if="error"
        color="error"
        :title="error.title"
        :description="error.message"
      />

      <!-- User Data Display -->
      <div v-if="userData" class="space-y-6">
        <!-- User Profile -->
        <div class="flex items-center space-x-4 p-4 bg-gray-50 rounded-lg">
          <img
            :src="userData.avatar_url"
            :alt="userData.login"
            class="w-16 h-16 rounded-full"
          />
          <div>
            <h2 class="text-xl font-bold">{{ userData.name }}</h2>
            <p class="text-gray-600">{{ userData.login }}</p>
            <p class="text-sm text-gray-500">{{ userData.email }}</p>
          </div>
        </div>

        <!-- Access Token -->
        <div class="space-y-2">
          <h3 class="font-bold">Access Token:</h3>
          <div class="bg-gray-50 p-4 rounded-lg break-all font-mono text-sm">
            {{ accessToken }}
          </div>
        </div>

        <!-- Raw Data -->
        <div class="space-y-2">
          <h3 class="font-bold">Raw User Data:</h3>
          <pre class="bg-gray-50 p-4 rounded-lg overflow-auto text-sm">{{ JSON.stringify(userData, null, 2) }}</pre>
        </div>

        <!-- Logout Button -->
        <div class="text-center">
          <UButton
            color="error"
            variant="soft"
            label="Clear Data"
            @click="clearData"
          />
        </div>
      </div>
    </div>
  </UContainer>
</template>

<script setup lang="ts">
// Types
interface GitHubError {
  title: string
  message: string
}

interface GitHubUser {
  login: string
  name: string
  email: string
  avatar_url: string
  [key: string]: unknown
}

interface GitHubResponse {
  error?: string
  error_description?: string
  access_token?: string
}

// State
const config = useRuntimeConfig()
const route = useRoute()
const isLoading = ref(false)
const loadingMessage = ref('')
const error = ref<GitHubError | null>(null)
const userData = ref<GitHubUser | null>(null)
const accessToken = ref<string | null>(null)

// Constants
const GITHUB_AUTH_URL = 'https://github.com/login/oauth/authorize'
const GITHUB_USER_URL = 'https://api.github.com/user'

// Methods
const handleLogin = () => {
  const params = new URLSearchParams()
  params.append('client_id', config.public.githubClientId as string)
  params.append('redirect_uri', window.location.href)
  params.append('scope', 'read:user user:email')
  window.location.href = `${GITHUB_AUTH_URL}?${params}`
}

const getAccessToken = async (code: string) => {
  try {
    isLoading.value = true
    loadingMessage.value = 'Getting access token...'

    const response = await fetch('/api/github/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code }),
    })

    const data = await response.json() as GitHubResponse
    if (data.error) {
      throw new Error(data.error_description || 'Failed to get access token')
    }
    if (!data.access_token) {
      throw new Error('No access token received')
    }

    return data.access_token
  } catch (err) {
    if (err instanceof Error) {
      error.value = {
        title: 'Authentication Error',
        message: err.message,
      }
    }
    return null
  }
}

const getUserData = async (token: string) => {
  try {
    loadingMessage.value = 'Fetching user data...'

    const response = await fetch(GITHUB_USER_URL, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error('Failed to fetch user data')
    }

    return await response.json() as GitHubUser
  } catch (err) {
    if (err instanceof Error) {
      error.value = {
        title: 'User Data Error',
        message: err.message,
      }
    }
    return null
  }
}

const clearData = () => {
  userData.value = null
  accessToken.value = null
  error.value = null
  // Remove code from URL without page reload
  window.history.replaceState({}, document.title, window.location.pathname)
}

// Handle OAuth callback
onMounted(async () => {
  const code = route.query.code as string
  if (code) {
    isLoading.value = true
    error.value = null

    // Get access token
    const token = await getAccessToken(code)
    if (token) {
      accessToken.value = token

      // Get user data
      const user = await getUserData(token)
      if (user) {
        userData.value = user
      }
    }

    isLoading.value = false
    // Remove code from URL without page reload
    window.history.replaceState({}, document.title, window.location.pathname)
  }
})
</script>
