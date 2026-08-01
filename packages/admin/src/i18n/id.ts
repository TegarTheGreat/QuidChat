import type { Dict } from "./en.js"

/**
 * The panel in Indonesian.
 *
 * Typed as `Dict`, so this file cannot be short of a key, cannot rename one, and cannot take
 * different arguments than the English version. A translation that silently falls back to English
 * would do it in front of exactly the person who cannot read English.
 *
 * Written as an Indonesian shop owner would say it, not word for word: "escalation" is not a word
 * anyone uses about their own shop, so it is "pertanyaan yang belum terjawab" — questions still
 * waiting for an answer. Where a technical term is genuinely the term (webhook, token, API key,
 * slug), it stays, because translating it would leave someone searching a vendor's documentation
 * for a word that is not in it.
 */
export const id: Dict = {
  common: {
    save: "Simpan",
    saving: "Menyimpan…",
    saved: "Tersimpan.",
    cancel: "Batal",
    delete: "Hapus",
    edit: "Ubah",
    add: "Tambah",
    close: "Tutup",
    refresh: "Muat ulang",
    loading: "Memuat…",
    optional: "opsional",
    nothing: "belum ada",
    on: "aktif",
    off: "nonaktif",
    actionsFor: (name: string) => `Tindakan untuk ${name}`,
  },

  language: {
    label: "Bahasa",
    english: "English",
    indonesian: "Bahasa Indonesia",
    hint: "Hanya untuk panel ini. Bahasa yang dibaca pelanggan diatur per tenant di Pengaturan.",
  },

  nav: {
    brand: "Panel QuidChat",
    setup: "Persiapan",
    overview: "Ringkasan",
    knowledge: "Pengetahuan",
    conversations: "Percakapan",
    skills: "Skill & perutean",
    canned: "Jawaban siap pakai",
    channels: "Saluran",
    escalations: "Belum terjawab",
    tenants: "Tenant",
    settings: "Pengaturan",
    signOut: "Keluar",
    switchTenant: "Ganti tenant",
  },

  app: {
    noTenants: "Belum ada tenant. Buat satu di bagian Tenant.",
  },

  token: {
    brand: "Panel QuidChat",
    title: "Token admin",
    description:
      "Panel ini butuh token yang dipakai saat server dijalankan — QUIDCHAT_ADMIN_TOKEN di environment-nya.",
    label: "Token",
    submit: "Buka panel",
    selectTenant: "Pilih tenant",
    noTenantSelected: "Belum ada tenant yang dipilih",
    manageTenants: "Kelola tenant",
    invalid: "Token ditolak. Periksa QUIDCHAT_ADMIN_TOKEN di server.",
  },

  setup: {
    title: "Persiapan",
    ready: "Siap menjawab pelanggan",
    readyDetail: "Tidak ada yang menghambat asisten. Sisanya di bawah ini opsional.",
    notReady: "Belum bisa menjawab",
    notReadyDetail: "Ada yang harus dibereskan dulu sebelum pelanggan bisa mendapat jawaban.",
    allClear: "Tidak ada catatan — tenant ini sudah lengkap.",
    severity: { blocker: "Menghambat", warning: "Perhatian", suggestion: "Saran" },
    whatToDo: "Yang perlu dilakukan: ",
    openSettings: "Buka pengaturan",
    addDocument: "Tambah dokumen",
    seeSources: "Lihat dokumen Anda",
    seeFailures: "Lihat yang gagal",
    writeAnswer: "Tulis jawaban",
    readQuestions: "Baca pertanyaannya",
    assistant: {
      title: "Tanya soal persiapan Anda",
      description:
        "Ia memeriksa keadaan sebenarnya sebelum menjawab — apa yang sudah terindeks, apa yang sudah diatur, apa kata diagnosanya — bukan menjawab dari ingatan.",
      placeholder: "Tanya apa saja tentang halaman ini",
      inputLabel: "Tanya asisten persiapan",
      ask: "Tanya",
      checking: "Memeriksa…",
      checked: (tools: string) => `Yang diperiksa: ${tools}`,
      doIt: "Lakukan",
      leaveIt: "Batalkan",
      openers: [
        "Kenapa asisten saya menolak pertanyaan?",
        "Mode jawaban itu mengubah apa?",
        "Ada yang menghambat asisten menjawab?",
      ] as readonly string[],
    },
  },

  overview: {
    title: "Ringkasan",
    questions: "Pertanyaan bulan ini",
    questionsHint: "Dari situs Anda dan semua saluran yang sudah terhubung.",
    answered: "Terjawab dari dokumen Anda",
    answeredNone: "Belum ada pertanyaan bulan ini.",
    answeredDetail: (answered: number, refused: number) =>
      `${answered} terjawab, ${refused} ditolak daripada dikira-kira.`,
    waiting: "Menunggu jawaban",
    waitingNone: "Tidak ada yang tertunda.",
    waitingSome: "Masing-masing adalah pertanyaan pelanggan yang belum ada di dokumen Anda.",
    answerThem: "Jawab sekarang",
    spent: "Terpakai bulan ini",
    budgetLoading: "Memuat anggaran Anda…",
    budgetNone:
      "Belum ada batas bulanan. Aturlah di Pengaturan sebelum ini dipakai di situs yang hidup.",
    budgetLeft: (left: string, total: string) =>
      `Sisa ${left} dari ${total}. Asisten berhenti menjawab kalau anggaran habis.`,
    budgetBarLabel: "Porsi anggaran bulan ini yang sudah terpakai",
  },

  knowledge: {
    title: "Pengetahuan",
    addSource: "Tambah sumber",
    columnTitle: "Judul",
    columnWhere: "Asal",
    columnStatus: "Status",
    empty:
      "Belum ada yang terindeks. Selama belum ada, semua pertanyaan ditolak — itu tandanya asisten bekerja, bukan rusak.",
    fromUrl: "halaman web",
    fromFile: "berkas unggahan",
    fromText: "teks yang ditempel",
    noReason: "Tidak ada alasan yang tercatat.",
    reindex: "Baca ulang halaman ini",
    reindexed: (title: string, chunks: number) =>
      `“${title}” dibaca ulang — ${chunks} bagian terindeks.`,
    reindexFailed: (title: string, reason: string) =>
      `“${title}” tidak bisa dibaca ulang: ${reason}. Teks yang lama masih dipakai.`,
    unknownReason: "sebab tidak diketahui",
    deleteTitle: (title: string) => `Hapus “${title}”?`,
    deleteDescription:
      "Teksnya dan semua hasil indeksnya ikut terhapus, dan asisten langsung berhenti menjawab dari situ. Jawaban lama tetap ada di transkrip tapi tidak lagi menautkannya. Sumbernya harus ditambahkan lagi.",
    deleteConfirm: "Hapus",
    dialog: {
      title: "Tambah sumber",
      description: "Asisten hanya menjawab dari apa yang ada di sini, dan menyebut sumbernya.",
      tabText: "Tempel teks",
      tabUrl: "Satu halaman",
      tabSite: "Seluruh situs",
      tabPdf: "Berkas PDF",
      titleLabel: "Judul",
      titleHint: "Pelanggan melihat nama ini di bawah jawaban yang berasal dari sini.",
      textLabel: "Teks",
      indexText: "Indeks teks ini",
      urlLabel: "Alamat",
      urlTitleLabel: "Judul (opsional)",
      urlTitlePlaceholder: "diambil dari halamannya kalau dikosongkan",
      readPage: "Baca halamannya",
      siteLabel: "Alamat awal",
      siteHint:
        "Tautan diikuti dari halaman ini, yang terdekat dulu, dan robots.txt dipatuhi. Alamat sitemap juga bisa, dan dibaca persis seperti isinya.",
      sitePagesLabel: "Maksimal berapa halaman",
      sitePagesHint:
        "Sampai 25. Setiap halaman diambil dan diindeks sebelum dialog ini tertutup, jadi situs besar lebih baik dibagi beberapa kali.",
      readSite: "Baca situs ini",
      readingSite: "Membaca situs…",
      pdfLabel: "Berkas",
      pdfHint:
        "Sampai sekitar 9 MB. PDF hasil pindai ditolak beserta alasannya — hurufnya berupa gambar, jadi harus lewat OCR dulu supaya bisa dibaca.",
      uploadPdf: "Unggah dan indeks",
      readingPdf: "Membaca…",
    },
    crawling: "Sedang membaca situsnya. Butuh waktu sebentar — satu halaman demi satu.",
    crawled: (pages: number) => `${pages} halaman terindeks.`,
    crawledWithFailures: (pages: number, failed: number, urls: string) =>
      `${pages} halaman terindeks. ${failed} tidak terbaca: ${urls}`,
  },

  conversations: {
    title: "Percakapan",
    description:
      "Apa yang ditanyakan pelanggan dan apa jawaban asisten, lengkap dengan dokumen di balik setiap klaim tentang bisnis Anda.",
    empty: "Belum ada percakapan. Akan muncul di sini begitu ada yang bertanya lewat widget.",
    select: "Pilih satu percakapan.",
    noMessages: "Tidak ada pesan yang tercatat di percakapan ini.",
    back: "Semua percakapan",
    messages: (count: number) => `${count} pesan`,
    unknownVisitor: "pengunjung tanpa nama",
    rowActions: (visitor: string) => `Tindakan untuk percakapan dengan ${visitor}`,
    deleteTranscript: "Hapus transkrip",
    deleteTitle: (visitor: string) => `Hapus transkrip dengan ${visitor}?`,
    deleteThisVisitor: "pengunjung ini",
    deleteDescription:
      "Semua pesan di dalamnya ikut terhapus, beserta sumber yang dikutip asisten dan catatan pertanyaan yang belum terjawab dari percakapan itu. Ini yang dipakai kalau pelanggan minta datanya dihapus. Yang tersisa hanya total biaya bulan ini, yang tidak memuat teks pesan.",
    deleteConfirm: "Hapus",
    writeAnswer: "Tulis jawaban untuk ini",
    saveDialog: {
      title: "Tulis jawaban untuk pertanyaan ini",
      description:
        "Jawaban siap pakai dikirim persis kata per kata, mendahului apa pun yang akan disusun asisten. Pakai kalau kalimatnya harus tepat.",
      question: "Pertanyaan",
      answer: "Jawaban",
      answerHint: "Ini yang tadi dijawab asisten. Perbaiki — biasanya itu alasan Anda ada di sini.",
      draft: "Simpan sebagai draf",
      publish: "Simpan dan pakai",
    },
    savedApproved: "Tersimpan. Mulai sekarang pertanyaan itu dijawab dengan kalimat Anda sendiri.",
    savedDraft:
      "Tersimpan sebagai draf. Baru dipakai setelah Anda setujui di layar Jawaban siap pakai.",
  },

  skills: {
    title: "Skill & perutean",
    addSkill: "Tambah skill",
    graphTitle: "Perjalanan pesan yang masuk",
    noSkills:
      "Belum ada skill. Tanpa skill, semua pertanyaan dijawab dari seluruh dokumen tenant ini — itu bawaan yang masuk akal, bukan masalah.",
    columnName: "Nama",
    columnRouting: "Diarahkan ke sini bila",
    columnSkill: "Skill",
    ruleWhen: "Bila",
    ruleWord: "Kata",
    ruleWordPlaceholder: "garansi",
    ruleKeyword: "pesannya mengandung sebuah kata",
    ruleFallback: "tidak ada aturan lain yang cocok",
    ruleOrderHint:
      "Aturan dijalankan berurutan dari atas dan yang pertama cocok yang dipakai, jadi aturan ini ditambahkan di urutan terakhir.",
    ruleDialogTitle: (skill: string) => `Kirim pesan ke ${skill}`,
    sourcesDialogTitle: (skill: string) => `Dokumen yang boleh dipakai ${skill}`,
    promptFooter:
      "Ditambahkan ke aturan penyebutan sumber, bukan menggantikannya — skill menentukan gaya dan cakupan, bukan apakah sumber wajib disebut.",
    modeInheritShort: "ikut tenant",
    namePlaceholder: "Penjualan",
    columnRoutingShort: "Perutean",
    linkedCount: (count: number) => `${count} tertaut`,
    addDescription: "Satu persona dengan instruksi dan bagian dokumennya sendiri.",
    editDescription:
      "Mengganti nama hanya mengubah yang Anda lihat di sini — jawaban asisten tidak terpengaruh.",
    deleteSkillDescription:
      "Aturan perutean dan tautan dokumennya ikut terhapus. Percakapan yang sudah dijawabnya tetap ada di transkrip — menghapus sebuah persona tidak boleh mengubah apa yang sudah disampaikan ke pelanggan.",
    deleteSkillConfirm: "Hapus skill",
    removeRuleTitle: "Hapus aturan ini?",
    removeRuleDescription:
      "Pesan yang tadinya ditangkap aturan ini akan turun ke aturan di bawahnya, lalu ke skill cadangan.",
    removeRuleConfirm: "Hapus aturan",
    promptLabelLong: "Cara menjawabnya",
    promptPlaceholder: "Anda menangani pertanyaan soal produk dan harga.",
    ruleKindLabel: "Jenis aturan",
    notBuiltHint: "Belum dibuat — aturan jenis ini dilewati saat pesan dirutekan.",
    noneTickedHint: "Kalau tidak ada yang dicentang, skill ini boleh menjawab dari semua dokumen.",
    noDocuments: "Belum ada dokumen yang terindeks.",
    columnDocuments: "Dokumen",
    columnMode: "Mode jawaban",
    fallbackBadge: "cadangan",
    disabledBadge: "nonaktif",
    noRules: "belum ada yang mengarah ke sini",
    allDocuments: "semuanya",
    documentCount: (count: number) => `${count} dipilih`,
    addRule: "Tambah aturan perutean",
    chooseDocuments: "Pilih dokumen",
    makeFallback: "Jadikan cadangan",
    disable: "Nonaktifkan",
    enable: "Aktifkan",
    deleteSkill: "Hapus",
    removeRule: (pattern: string) => `Hapus aturan untuk ${pattern}`,
    dialog: {
      addTitle: "Tambah skill",
      editTitle: (name: string) => `Ubah ${name}`,
      description:
        "Skill adalah satu topik dengan instruksi dan dokumennya sendiri — penjualan, pengiriman, garansi. Perutean menentukan siapa yang menjawab.",
      nameLabel: "Nama",
      promptLabel: "Instruksi",
      promptHint:
        "Dikirim setiap kali skill ini menjawab. Tulis cara menjawabnya, bukan faktanya — fakta datang dari dokumen.",
      modeLabel: "Mode jawaban",
      modeInherit: "Ikut tenant ini",
      fallbackLabel: "Jawab apa pun yang tidak cocok dengan aturan mana pun",
      enabledLabel: "Dipakai",
    },
    ruleDialog: {
      title: (skill: string) => `Arahkan ke ${skill} bila…`,
      description:
        "Aturan dibaca dari atas, dan yang pertama cocok yang dipakai. Aturan kata kunci itu pasti dan gratis; yang lain belum dibuat.",
      kindLabel: "Jenis",
      patternLabel: "Kata kunci",
      patternHint: "Dicocokkan di mana pun dalam pesan pelanggan, tanpa membedakan huruf besar-kecil.",
      submit: "Tambah aturan",
    },
    sourcesDialog: {
      title: (skill: string) => `Dokumen yang boleh dipakai ${skill}`,
      description:
        "Kalau tidak ada yang dipilih, berarti seluruh dokumen tenant ini. Pilih beberapa untuk mempersempit — skill garansi yang menjawab dari daftar harga adalah cara jawaban salah mendapat kutipan sumber.",
      empty: "Tenant ini belum punya dokumen.",
    },
    deleteTitle: (name: string) => `Hapus ${name}?`,
    deleteDescription:
      "Aturan peruteannya ikut terhapus, dan pertanyaan yang tadinya ditangkap aturan itu akan dijawab dari seluruh dokumen tenant ini. Dokumennya sendiri tetap ada.",
    deleteConfirm: "Hapus",
    ruleKinds: { keyword: "kata kunci", semantic: "kemiripan makna", llm: "diputuskan model", fallback: "cadangan" },
  },

  routing: {
    everythingElse: "Semua pesan lain",
    contains: (pattern: string) => `Mengandung “${pattern}”`,
    noKeyword: "Tanpa kata kunci",
    similar: "Mirip maknanya",
    modelDecides: "Diputuskan model",
    empty: "Belum ada aturan. Semua pesan dijawab langsung, tanpa memilih skill.",
    off: "nonaktif",
    notBuilt: "belum dibuat",
    neverReached: "tak pernah dijalankan",
    fallback: "cadangan",
    sources: (count: number) => `${count} sumber`,
    handoffOnly: (names: string) =>
      `Tidak ada aturan yang mengarah ke ${names}. Skill ini hanya bisa dicapai kalau skill lain mengoper pertanyaannya.`,
    footnote:
      "Aturan dijalankan dari atas ke bawah, dan yang pertama cocok yang dipakai. Selain itu, skill yang sedang menjawab bisa mengoper pertanyaan ke skill lain kalau ternyata bukan bidangnya.",
  },

  canned: {
    title: "Jawaban siap pakai",
    lead: "Jawaban pasti untuk pertanyaan pasti, dicocokkan tanpa memanggil model. Dalam mode static, hanya inilah yang bisa dikatakan asisten, jadi tidak ada biaya jalannya.",
    count: (total: number) => `${total} jawaban`,
    waitingApproval: (count: number) => `${count} menunggu persetujuan`,
    emptyStatic:
      "Belum ada. Tenant dalam mode static tanpa jawaban yang disetujui akan menolak semua pertanyaan — memang begitu, karena alternatifnya adalah mengarang.",
    columnActions: "Tindakan",
    draftBadge: "Draf — belum dikirim",
    questionLabel: "Pertanyaan seperti yang ditanyakan pelanggan",
    questionPlaceholder: "Garansinya berapa lama?",
    answerLabel: "Jawaban yang dikirim, persis kata per kata",
    answerPlaceholder: "Semua unit bergaransi satu tahun sejak tanggal pembelian.",
    addDescription:
      "Pencocokan memaklumi kalimat yang berbeda dan salah ketik, jadi tulislah pertanyaannya seperti pelanggan bertanya — bukan sebagai kata kunci.",
    editDescription:
      "Menyimpan mengembalikannya menjadi draf — persetujuan tadi untuk kalimat yang lama, dan sebaiknya ada orang yang membaca kalimat barunya sebelum pelanggan membacanya.",
    deleteAnswer: "Hapus jawaban",
    addAnswer: "Tambah jawaban",
    columnQuestion: "Pertanyaan",
    columnAnswer: "Jawaban",
    columnStatus: "Status",
    empty: "Belum ada yang ditulis.",
    live: "Dipakai",
    draft: "Draf",
    approve: "Setujui",
    withdraw: "Tarik kembali",
    deleteTitle: (question: string) => `Hapus “${question}”?`,
    deleteDescription:
      "Asisten kembali menyusun jawaban untuk pertanyaan ini dari dokumen Anda, atau menolak kalau dokumennya tidak memuatnya.",
    deleteConfirm: "Hapus",
    dialog: {
      addTitle: "Tambah jawaban",
      editTitle: "Ubah jawaban ini",
      description:
        "Dicocokkan dengan pertanyaan yang maksudnya sama, bukan hanya kata yang persis. Jawaban yang diubah kembali menjadi draf, karena persetujuannya dulu untuk kalimat yang sudah tidak ada.",
      questionLabel: "Pertanyaan",
      answerLabel: "Jawaban",
      addAndApprove: "Tambah dan setujui",
      addAsDraft: "Tambah sebagai draf",
      saveChanges: "Simpan perubahan",
    },
  },

  channels: {
    title: "Saluran",
    description:
      "Asisten yang sama, menjawab di tempat pelanggan Anda sudah berada. Semua saluran melewati alur yang sama persis, jadi penyebutan sumber, penolakan, dan anggaran berlaku sama seperti di situs Anda.",
    noKeyTitle: "Kredensial belum bisa disimpan",
    noKeyBody: (generate: string) =>
      `Setel QUIDCHAT_SECRET_KEY di server lalu jalankan ulang. Kredensial saluran dienkripsi dengan kunci itu, dan menyimpannya sebagai teks biasa tidak ditawarkan sebagai alternatif — satu cadangan basis data akan menyerahkan kemampuan mengirim pesan atas nama bisnis Anda. Buat kuncinya dengan ${generate}.`,
    columnChannel: "Saluran",
    columnStatus: "Status",
    columnStored: "Tersimpan",
    connected: "Terhubung",
    paused: "Dijeda",
    notConnected: "Belum terhubung",
    connect: "Hubungkan",
    replace: "Ganti kredensial",
    pause: "Jeda",
    resume: "Lanjutkan",
    disconnect: "Putuskan",
    disconnectTitle: (name: string) => `Putuskan ${name}?`,
    disconnectDescription:
      "Kredensial yang tersimpan dihapus, dan pesan yang masuk lewat saluran itu berhenti dijawab. Untuk menghubungkannya lagi Anda butuh token dari platformnya sekali lagi — kalau hanya ingin berhenti menjawab sementara, jeda saja.",
    disconnectConfirm: "Putuskan",
    dialogConnect: (name: string) => `Hubungkan ${name}`,
    dialogReplace: (name: string) => `Ganti kredensial ${name}`,
    pointAt: (name: string) => `Arahkan ${name} ke alamat ini`,
    copyAddress: "Salin alamat webhook",
    stored: "tersimpan — ketik untuk mengganti",
    secretHint:
      "Isi juga webhook secret kalau platformnya menyediakan. Tanpa itu, siapa pun yang tahu alamat di atas bisa menyisipkan kalimat ke riwayat percakapan Anda dan menghabiskan anggaran Anda.",
  },

  escalations: {
    title: "Belum terjawab",
    description:
      "Pertanyaan yang ditolak asisten daripada dikira-kira. Menjawabnya di sini menyimpannya sebagai jawaban siap pakai, jadi pelanggan berikutnya yang bertanya langsung dapat jawaban.",
    empty:
      "Belum ada yang ditolak. Pada asisten yang hidup, daftar ini terisi bukan berarti rusak — itu tandanya asisten menolak mengarang, dan dari situlah datang hal berikutnya yang perlu Anda tuliskan.",
    columnQuestion: "Yang ditanyakan pelanggan",
    columnWhen: "Kapan",
    columnState: "Keadaan",
    columnAnswer: "Jawab",
    handled: "Sudah ditangani",
    open: "Terbuka",
    noQuestion: "Pertanyaannya tidak tercatat",
    writeAnswer: "Tulis jawaban",
    dismiss: "Tandai selesai",
    reopen: "Buka lagi",
    reasons: {
      no_source: "Tidak ada di dokumen Anda",
      ungrounded: "Jawabannya tidak bisa didukung sumber",
      budget_exhausted: "Anggaran bulan ini sudah habis",
      provider_unavailable: "Penyedia AI tidak bisa dihubungi",
      handoff_limit: "Terlalu sering dioper antar skill",
      rate_limited: "Terlalu banyak pesan dalam waktu singkat",
    } as Record<string, string>,
    dialog: {
      title: "Jawab pertanyaan ini",
      description:
        "Disimpan sebagai jawaban siap pakai yang sudah disetujui, dan dicocokkan dengan pertanyaan berikutnya, termasuk yang kalimatnya berbeda. Dikirim persis kata per kata, jadi tulislah seperti yang Anda ingin dibaca pelanggan.",
      question: "Pertanyaannya",
      answer: "Jawaban Anda",
      answerPlaceholder: "Bisa — kami kirim ke seluruh Jawa, dan ke Bali sekitar tiga hari.",
      submit: "Simpan dan pakai",
    },
    savedNotResolved: (reason: string) =>
      `Jawabannya tersimpan, tapi baris ini gagal ditandai selesai: ${reason}`,
  },

  tenants: {
    title: "Tenant",
    addTenant: "Tambah tenant",
    columnName: "Nama",
    columnSlug: "Slug",
    empty: "Belum ada bisnis. Tambahkan satu untuk mendapat cuplikan embed dan tempat menaruh pengetahuan.",
    openBadge: "Sedang dibuka",
    workOnThis: "Kerjakan yang ini",
    rename: "Ganti nama",
    delete: "Hapus",
    createTitle: "Tambah tenant",
    createDescription:
      "Satu bisnis, dengan pengetahuan, saluran, dan kuncinya sendiri. Tidak ada yang dibagi antar tenant.",
    nameLabel: "Nama",
    slugLabel: "Slug",
    slugHint: "Dipakai di cuplikan embed, jadi pilih sekali — nanti tidak bisa diubah.",
    originsLabel: "Situs yang diizinkan",
    originsHint: "Situs yang boleh membuka widget ini. Kosongkan saja selama masih uji coba lokal.",
    createSubmit: "Tambah tenant ini",
    creating: "Menambahkan…",
    renameTitle: (name: string) => `Ganti nama “${name}”`,
    renameDescription: (slug: string) =>
      `Hanya yang Anda lihat di panel. Pelanggan melihat judul widget, dan slug di cuplikan embed tetap ${slug}.`,
    renameSubmit: "Simpan nama",
    deleteTitle: (name: string) => `Hapus “${name}”?`,
    deleteDescription:
      "Pengetahuan, percakapan, transkrip, sambungan saluran, dan kunci penyedia yang tersimpan ikut terhapus, dan widget di situsnya berhenti menjawab. Tidak bisa dibatalkan, dan tidak ada cadangan yang dibuat lebih dulu.",
    deleteConfirmLabel: (slug: string) => `Ketik ${slug} untuk memastikan`,
    deleteSubmit: "Hapus tenant ini",
    deleting: "Menghapus…",
  },

  settings: {
    title: "Pengaturan",
    selectTenant: "Pilih tenant dulu untuk mengubah pengaturannya.",
    originsPlaceholder: "https://tokosaya.example",
    widgetDisabledTitle: "Widget tidak aktif",
    widgetDisabledBody:
      "Belum ada situs yang diizinkan, jadi widget akan menolak semua situs. Tambahkan minimal satu situs supaya widget hidup.",
    modelsUnavailable: "Tambahkan kunci penyedia di atas, lalu model yang tersedia akan muncul di sini.",
    save: "Simpan perubahan",
    tabs: { models: "Model", answering: "Cara menjawab", limits: "Batas", widget: "Widget" },
    form: {
      chatModel: "Model penjawab",
      rewriteModel: "Model penulis ulang",
      embeddingModel: "Model pencarian",
      answerMode: "Mode jawaban",
      answerModeFull: "full — susun jawaban dari dokumen Anda",
      answerModeThrifty: "thrifty — kutip dokumen Anda, tanpa menyusun kalimat baru",
      answerModeStatic: "static — hanya jawaban siap pakai yang disetujui, tanpa model",
      answerModeHint:
        "Satu-satunya pengaturan yang mengubah biaya menjalankan ini. Mode static tidak pernah memanggil model, jadi gratis dijalankan dan hanya bisa mengatakan apa yang sudah disetujui seseorang.",
      refusalText: "Kalimat penolakan",
      escalationMode: "Kalau tidak bisa menjawab",
      escalationCollect: "catat di sini — dibaca di menu Belum terjawab",
      escalationWebhook: "kirim ke webhook — Slack, Discord, n8n, CRM Anda",
      webhookUrl: "Alamat webhook",
      webhookHint:
        "Dikirim sebagai JSON berisi pertanyaan pelanggan, alasannya, dan salurannya — pertanyaannya itulah yang memberi tahu Anda apa yang perlu ditulis. Hanya dipakai kalau mode di atas disetel ke webhook.",
      highRisk: "Topik berisiko tinggi",
      highRiskPlaceholder: "mis. saran medis",
      budget: "Anggaran bulanan (sen dolar)",
      retention: "Simpan percakapan (hari)",
      handoffsTurn: "Operan maksimal per pertanyaan",
      handoffsConversation: "Operan maksimal per percakapan",
      allowedOrigins: "Situs yang diizinkan",
      accent: "Warna aksen",
      side: "Letaknya di sisi mana",
      sideRight: "kanan bawah",
      sideLeft: "kiri bawah",
      widgetLanguage: "Bahasa tombol dan teks bantuan",
      greeting: "Kalimat pertama yang dibaca pelanggan",
      greetingPlaceholder: "Halo! Ada yang bisa kami bantu?",
      starters: "Pertanyaan yang ditawarkan sebelum mereka mengetik",
      startersPlaceholder: "mis. Berapa lama garansinya?",
      widgetTitle: "Judul yang dilihat pelanggan",
      widgetTitlePlaceholder: "Asisten toko",
    },
    provider: {
      title: "Penyedia AI",
      usingServer:
        "Memakai apa pun yang dipakai server ini saat dijalankan. Tambahkan kunci di bawah untuk memakai akun Anda sendiri.",
      usingOwn: "Menjawab dengan kunci Anda sendiri:",
      noSecretKey:
        "Deployment ini belum punya QUIDCHAT_SECRET_KEY, jadi kredensial belum bisa disimpan dengan aman. Buat kuncinya dengan openssl rand -base64 32 lalu jalankan ulang.",
      providerLabel: "Penyedia",
      keyLabel: "API key",
      addressLabel: "Alamat",
      use: (name: string) => `Pakai ${name}`,
      useServer: "Kembali ke penyedia server ini",
      remove: (name: string) => `Hapus kunci ${name}`,
      stored: "tersimpan — ketik untuk mengganti",
      localRunner: (models: string, more: boolean) =>
        `Sudah ada model yang berjalan di server ini, dengan ${models}${more ? " dan lainnya" : ""}. Tidak ada data yang keluar dari mesin Anda dan tidak ada biayanya.`,
      useLocalRunner: "Pakai ini",
      where: {
        OPENAI_API_KEY: "platform.openai.com → API keys",
        GROQ_API_KEY: "console.groq.com → API keys. Ada paket gratis, dan paling cepat di antara ini.",
        GEMINI_API_KEY: "aistudio.google.com → Get API key. Ada paket gratis.",
        ANTHROPIC_API_KEY: "console.anthropic.com → API keys",
        OPENROUTER_API_KEY:
          "openrouter.ai → Keys. Satu kunci untuk model dari semua penyedia di atas.",
        OLLAMA_BASE_URL:
          "Tanpa kunci dan tanpa akun. Tidak ada data yang keluar dari server Anda, dan tidak ada biayanya.",
      } as Record<string, string>,
    },
    model: {
      loading: "Menanyakan model apa saja yang tersedia…",
      failed: "Daftar model tidak bisa diambil — ketik namanya saja.",
      typeInstead: "Ketik namanya saja",
      chooseInstead: "Pilih dari daftar",
      empty: "Penyedia Anda tidak mengembalikan model apa pun.",
    },
    fields: {
      chatModel: "Model untuk menjawab",
      rewriteModel: "Model untuk menulis ulang pertanyaan",
      embeddingModel: "Model untuk pencarian",
      answerMode: "Mode jawaban",
      answerModeStatic: "Hanya jawaban yang disetujui",
      answerModeThrifty: "Cari di dokumen",
      answerModeFull: "Cari, setelah pertanyaannya ditulis ulang",
      refusalText: "Kalimat saat asisten tidak tahu",
      escalationMode: "Saat asisten menyerah",
      escalationTarget: "Kirim pemberitahuan ke",
      monthlyBudget: "Anggaran bulanan (dolar AS)",
      retentionDays: "Simpan percakapan selama (hari)",
      highRiskTopics: "Jangan pernah dikira-kira",
      allowedOrigins: "Situs yang diizinkan",
      maxHandoffsTurn: "Operan per pertanyaan",
      maxHandoffsConversation: "Operan per percakapan",
      widgetColor: "Warna aksen",
      widgetPosition: "Sisi layar",
      widgetPositionLeft: "Kiri",
      widgetPositionRight: "Kanan",
      widgetTitle: "Judul di kepala widget",
      widgetLocale: "Bahasa yang dilihat pelanggan",
      widgetGreeting: "Kalimat pertama yang dibaca pelanggan",
      widgetStarters: "Pertanyaan pembuka yang ditawarkan",
    },
  },
}
