export interface TokenValidation {
  valid: boolean;
  error?: string;
}

export interface AccountValidation {
  valid: boolean;
  name?: string;
  error?: string;
}

export async function validateToken(token: string): Promise<TokenValidation> {
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/user/tokens/verify', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json() as { success: boolean; result?: { status: string }; errors?: Array<{ message: string }> };

    if (data.success && data.result?.status === 'active') {
      return { valid: true };
    }

    const message = data.errors?.[0]?.message || 'Token is not active';
    return { valid: false, error: message };
  } catch (err) {
    return { valid: false, error: `Network error: ${(err as Error).message}` };
  }
}

export async function validateAccount(token: string, accountId: string): Promise<AccountValidation> {
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await response.json() as { success: boolean; result?: { name: string }; errors?: Array<{ message: string }> };

    if (data.success && data.result?.name) {
      return { valid: true, name: data.result.name };
    }

    const message = data.errors?.[0]?.message || 'Account not found or token lacks permission';
    return { valid: false, error: message };
  } catch (err) {
    return { valid: false, error: `Network error: ${(err as Error).message}` };
  }
}
