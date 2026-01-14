---
title: Builds
---

<script setup>
import { onMounted } from 'vue'
import { withBase } from 'vitepress'

onMounted(() => {
  // Use a hard redirect so it works even when served as a static site.
  window.location.replace(withBase('/builds/'))
})
</script>

Redirecting to **[Builds](./builds/)**...
