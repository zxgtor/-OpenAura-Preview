const maxBytes = 100 * 1024 * 1024
const types = {
  image: ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'image/bmp'],
  video: ['video/mp4', 'video/webm', 'video/ogg']
}
let database

export function validMedia(blob, type) {
  return blob instanceof Blob && blob.size > 0 && blob.size <= maxBytes && types[type]?.includes(blob.type)
}

async function openDatabase() {
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open('openaura.infinite-canvas.media.v1', 1)
    let blocked = false
    request.onupgradeneeded = () => request.result.createObjectStore('files')
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return }
      request.result.onversionchange = () => { request.result.close(); database = null }
      resolve(request.result)
    }
    request.onerror = () => reject(request.error)
    request.onblocked = () => { blocked = true; reject(new Error('Media storage is blocked by another window.')) }
  }).catch(error => { database = null; throw error })
  return database
}

export async function mediaFile(action, id, blob) {
  const db = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('files', action === 'get' ? 'readonly' : 'readwrite')
    const store = transaction.objectStore('files')
    const request = action === 'put' ? store.put(blob, id) : action === 'delete' ? store.delete(id) : store.get(id)
    transaction.oncomplete = () => resolve(request.result)
    transaction.onabort = () => reject(transaction.error || new Error('Media storage failed.'))
    transaction.onerror = () => reject(transaction.error || new Error('Media storage failed.'))
  })
}

export function checkMedia(blob, type) {
  return new Promise((resolve, reject) => {
    const media = document.createElement(type === 'image' ? 'img' : 'video')
    const url = URL.createObjectURL(blob)
    const finish = error => {
      clearTimeout(timer)
      media.onload = media.onloadedmetadata = media.onerror = null
      media.removeAttribute('src')
      if (type === 'video') media.load()
      URL.revokeObjectURL(url)
      error ? reject(error) : resolve()
    }
    const timer = setTimeout(() => finish(new Error('The file could not be loaded.')), 15000)
    media.onload = media.onloadedmetadata = () => finish()
    media.onerror = () => finish(new Error('This image or video format cannot be displayed.'))
    if (type === 'video') media.preload = 'metadata'
    media.src = url
  })
}
