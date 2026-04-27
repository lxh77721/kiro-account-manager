import os from 'os'
import path from 'path'

function getElectronUserDataPath(): string | null {
  if (!process.versions.electron) {
    return null
  }

  try {
    const runtimeRequire = Function('return typeof require !== "undefined" ? require : null')() as
      | NodeRequire
      | null

    if (!runtimeRequire) {
      return null
    }

    const electron = runtimeRequire('electron') as { app?: { getPath: (name: 'userData') => string } }
    return electron.app?.getPath('userData') ?? null
  } catch {
    return null
  }
}

export function getRuntimeUserDataPath(appFolder = '.kiro-account-manager-web'): string {
  if (process.env.KIRO_USER_DATA_PATH) {
    return process.env.KIRO_USER_DATA_PATH
  }

  return getElectronUserDataPath() ?? path.join(os.homedir(), appFolder)
}
