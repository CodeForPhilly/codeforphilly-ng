# GitHub OAuth Test Page Setup

This guide explains how to set up and test GitHub OAuth login functionality without Supabase integration.

## 1. Create GitHub OAuth App

1. Go to GitHub Developer Settings:
   - Visit <https://github.com/settings/developers>
   - Click "OAuth Apps" in the sidebar
   - Click "New OAuth App"

2. Fill in the application details:
   - **Application name**: `Code for Philly Dev`
   - **Homepage URL**: `http://localhost:3000`
   - **Authorization callback URL**: `http://localhost:3000/test/github-login`
   - Click "Register application"

3. After registration:
   - You'll see your Client ID immediately
   - Click "Generate a new client secret"
   - Save both the Client ID and Client Secret

## 2. Configure Environment Variables

1. Add these variables to your `.env` file:

```bash
# GitHub OAuth
NUXT_GITHUB_CLIENT_ID=your_client_id_here
NUXT_GITHUB_CLIENT_SECRET=your_client_secret_here
```

## 3. Implementation Details

The test page is located at `/test/github-login` and implements:

1. Initial state with login button
2. OAuth redirect handling
3. Display of user data after successful login

### How it Works

1. User clicks "Login with GitHub"
2. GitHub OAuth flow initiates
3. After authorization, GitHub redirects back with a code
4. The page exchanges the code for an access token
5. User data is fetched and displayed

### Testing

1. Start the development server:

   ```bash
   npm run dev
   ```

2. Visit <http://localhost:3000/test/github-login>

3. Click "Login with GitHub"

4. After authorizing, you'll see:
   - Access token
   - User profile data
   - Raw API response

## Security Notes

- This is a test implementation
- Never commit OAuth secrets to version control
- The client secret should be kept secure in production
- This implementation is for local testing only

## Troubleshooting

1. If the login button doesn't work:
   - Verify your OAuth app settings
   - Check that environment variables are set
   - Ensure the callback URL matches exactly

2. If you get a redirect error:
   - Verify the callback URL in GitHub matches exactly
   - Check for any typos in the environment variables

3. If no user data displays:
   - Check browser console for errors
   - Verify the access token is being received
   - Check GitHub API response in the Network tab
