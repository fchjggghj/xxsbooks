import { useState, useEffect } from 'react';
import { apiGet, apiPost, apiPut, apiDelete, type NewBook, type NewBookChapter, type NewBooksResponse, type OutlinePoolItem, type PoolItemsResponse } from '../lib/api';

export default function Composer() {
  const [books, setBooks] = useState<NewBook[]>([]);
  const [poolItems, setPoolItems] = useState<OutlinePoolItem[]>([]);
  const [selectedBook, setSelectedBook] = useState<NewBook | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showAddChapterModal, setShowAddChapterModal] = useState(false);
  const [newBookData, setNewBookData] = useState({ title: '', author: '', genre: '', description: '' });

  useEffect(() => {
    fetchBooks();
    fetchPoolItems();
  }, []);

  async function fetchBooks() {
    try {
      const res = await apiGet<NewBooksResponse>('/books/new');
      setBooks(res.books);
    } catch (err) {
      console.error('获取新书列表失败:', err);
    }
  }

  async function fetchPoolItems() {
    try {
      const res = await apiGet<PoolItemsResponse>('/pool');
      setPoolItems(res.items);
    } catch (err) {
      console.error('获取大纲池失败:', err);
    }
  }

  async function handleCreateBook() {
    if (!newBookData.title.trim()) {
      alert('请输入书名');
      return;
    }
    try {
      const book: Omit<NewBook, 'id' | 'createdAt'> = {
        ...newBookData,
        chapters: [],
        totalChapters: 0,
        wordCount: 0,
      };
      await apiPost<NewBook>('/books/new', book);
      setShowCreateModal(false);
      setNewBookData({ title: '', author: '', genre: '', description: '' });
      fetchBooks();
    } catch (err) {
      console.error('创建新书失败:', err);
    }
  }

  async function handleSelectBook(book: NewBook) {
    setSelectedBook(book);
  }

  async function handleAddChapterFromPool(poolItem: OutlinePoolItem) {
    if (!selectedBook) return;
    const chapter: Omit<NewBookChapter, 'id'> = {
      index: selectedBook.chapters.length + 1,
      title: `第${selectedBook.chapters.length + 1}章`,
      content: poolItem.outlineName,
      sourcePoolItemId: poolItem.id,
    };
    try {
      await apiPost<NewBook>(`/books/new/${selectedBook.id}/chapters`, chapter);
      setShowAddChapterModal(false);
      fetchBooks();
      const updated = await apiGet<NewBook>(`/books/new/${selectedBook.id}`);
      setSelectedBook(updated);
    } catch (err) {
      console.error('添加章节失败:', err);
    }
  }

  async function handleAddCustomChapter() {
    if (!selectedBook) return;
    const chapter: Omit<NewBookChapter, 'id'> = {
      index: selectedBook.chapters.length + 1,
      title: `第${selectedBook.chapters.length + 1}章 新章节`,
      content: '请输入章节大纲内容...',
      sourcePoolItemId: '',
    };
    try {
      await apiPost<NewBook>(`/books/new/${selectedBook.id}/chapters`, chapter);
      setShowAddChapterModal(false);
      fetchBooks();
      const updated = await apiGet<NewBook>(`/books/new/${selectedBook.id}`);
      setSelectedBook(updated);
    } catch (err) {
      console.error('添加章节失败:', err);
    }
  }

  async function handleUpdateChapter(chapterId: string, updates: Partial<NewBookChapter>) {
    if (!selectedBook) return;
    try {
      const updatedChapters = selectedBook.chapters.map((ch) =>
        ch.id === chapterId ? { ...ch, ...updates } : ch
      );
      await apiPut<NewBook>(`/books/new/${selectedBook.id}`, { ...selectedBook, chapters: updatedChapters });
      const updated = await apiGet<NewBook>(`/books/new/${selectedBook.id}`);
      setSelectedBook(updated);
    } catch (err) {
      console.error('更新章节失败:', err);
    }
  }

  async function handleRemoveChapter(chapterId: string) {
    if (!selectedBook || !confirm('确定删除该章节？')) return;
    try {
      await apiDelete(`/books/new/${selectedBook.id}/chapters/${chapterId}`);
      fetchBooks();
      const updated = await apiGet<NewBook>(`/books/new/${selectedBook.id}`);
      setSelectedBook(updated);
    } catch (err) {
      console.error('删除章节失败:', err);
    }
  }

  async function handleExportOutline() {
    if (!selectedBook) return;
    try {
      await apiPost<{ path: string }>(`/books/new/${selectedBook.id}/export`);
      alert('大纲已导出！');
    } catch (err) {
      console.error('导出大纲失败:', err);
    }
  }

  async function handleDeleteBook(bookId: string) {
    if (!confirm('确定删除该书？')) return;
    try {
      await apiDelete(`/books/new/${bookId}`);
      setSelectedBook(null);
      fetchBooks();
    } catch (err) {
      console.error('删除新书失败:', err);
    }
  }

  const genres = [...new Set(poolItems.map((item) => item.genre))];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
      <div className="lg:col-span-1">
        <div className="bg-white rounded-xl shadow-sm p-4">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold">新书列表</h2>
            <button
              onClick={() => setShowCreateModal(true)}
              className="px-3 py-1 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm"
            >
              + 新建
            </button>
          </div>
          <div className="space-y-2">
            {books.length === 0 ? (
              <p className="text-gray-500 text-sm">暂无新书，请创建</p>
            ) : (
              books.map((book) => (
                <div
                  key={book.id}
                  onClick={() => handleSelectBook(book)}
                  className={`p-3 rounded-lg cursor-pointer transition-colors ${
                    selectedBook?.id === book.id
                      ? 'bg-blue-50 border-2 border-blue-500'
                      : 'bg-gray-50 hover:bg-gray-100 border-2 border-transparent'
                  }`}
                >
                  <div className="font-medium text-gray-900">{book.title}</div>
                  <div className="text-sm text-gray-500">{book.genre} · {book.totalChapters}章</div>
                  <div className="text-xs text-gray-400">{book.wordCount}字</div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <div className="lg:col-span-2">
        {selectedBook ? (
          <div className="space-y-6">
            <div className="bg-white rounded-xl shadow-sm p-6">
              <div className="flex items-start justify-between">
                <div>
                  <h1 className="text-2xl font-bold">{selectedBook.title}</h1>
                  <p className="text-gray-500 mt-1">{selectedBook.author}</p>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={() => setShowAddChapterModal(true)}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
                  >
                    + 添加章节
                  </button>
                  <button
                    onClick={handleExportOutline}
                    className="px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 text-sm"
                  >
                    导出大纲
                  </button>
                  <button
                    onClick={() => handleDeleteBook(selectedBook.id)}
                    className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm"
                  >
                    删除
                  </button>
                </div>
              </div>
              <div className="mt-4 flex items-center gap-4">
                <span className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800">
                  {selectedBook.genre}
                </span>
                <span className="text-sm text-gray-500">{selectedBook.totalChapters} 章节</span>
                <span className="text-sm text-gray-500">{selectedBook.wordCount} 字数</span>
              </div>
              <div className="mt-4">
                <label className="block text-sm font-medium text-gray-700 mb-1">简介</label>
                <textarea
                  value={selectedBook.description}
                  onChange={(e) => handleUpdateChapter('', { index: 0 })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  rows={3}
                />
              </div>
            </div>

            <div className="bg-white rounded-xl shadow-sm overflow-hidden">
              <div className="px-4 py-3 border-b bg-gray-50">
                <h3 className="font-medium">章节列表</h3>
              </div>
              <div className="divide-y divide-gray-200">
                {selectedBook.chapters.length === 0 ? (
                  <div className="px-4 py-8 text-center text-gray-500">
                    暂无章节，点击上方按钮添加
                  </div>
                ) : (
                  selectedBook.chapters.map((chapter) => (
                    <div key={chapter.id} className="px-4 py-4 hover:bg-gray-50">
                      <div className="flex items-center justify-between mb-2">
                        <div className="flex items-center gap-3">
                          <span className="text-lg font-bold text-blue-600">第{chapter.index}章</span>
                          <input
                            type="text"
                            value={chapter.title}
                            onChange={(e) => handleUpdateChapter(chapter.id, { title: e.target.value })}
                            className="font-medium text-gray-900 border-b border-transparent hover:border-gray-300 focus:border-blue-500 outline-none"
                          />
                        </div>
                        <button
                          onClick={() => handleRemoveChapter(chapter.id)}
                          className="text-red-600 hover:text-red-900 text-sm"
                        >
                          删除
                        </button>
                      </div>
                      <textarea
                        value={chapter.content}
                        onChange={(e) => handleUpdateChapter(chapter.id, { content: e.target.value })}
                        className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm"
                        rows={4}
                        placeholder="输入章节大纲内容..."
                      />
                      {chapter.sourcePoolItemId && (
                        <div className="mt-2 text-xs text-gray-400">
                          来源：大纲池项 {chapter.sourcePoolItemId}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-xl shadow-sm p-12 text-center">
            <div className="text-gray-400 text-6xl mb-4">📚</div>
            <h2 className="text-xl font-medium text-gray-900">选择一本新书开始编辑</h2>
            <p className="text-gray-500 mt-2">或点击左侧"新建"按钮创建新书</p>
          </div>
        )}
      </div>

      {showCreateModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">创建新书</h2>
              <button
                onClick={() => setShowCreateModal(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">书名</label>
                <input
                  type="text"
                  value={newBookData.title}
                  onChange={(e) => setNewBookData({ ...newBookData, title: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="输入书名"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">作者</label>
                <input
                  type="text"
                  value={newBookData.author}
                  onChange={(e) => setNewBookData({ ...newBookData, author: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  placeholder="输入作者名"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">题材</label>
                <select
                  value={newBookData.genre}
                  onChange={(e) => setNewBookData({ ...newBookData, genre: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                >
                  <option value="">选择题材</option>
                  {genres.map((genre) => (
                    <option key={genre} value={genre}>{genre}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">简介</label>
                <textarea
                  value={newBookData.description}
                  onChange={(e) => setNewBookData({ ...newBookData, description: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg"
                  rows={3}
                  placeholder="输入书籍简介..."
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200"
              >
                取消
              </button>
              <button
                onClick={handleCreateBook}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                创建
              </button>
            </div>
          </div>
        </div>
      )}

      {showAddChapterModal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[80vh] overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b">
              <h2 className="text-lg font-semibold">添加章节</h2>
              <button
                onClick={() => setShowAddChapterModal(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>
            <div className="p-6">
              <div className="mb-4">
                <button
                  onClick={handleAddCustomChapter}
                  className="px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700"
                >
                  + 添加自定义章节
                </button>
              </div>
              <div className="border-t pt-4">
                <h3 className="font-medium text-gray-700 mb-3">从大纲池选择</h3>
                <div className="space-y-2 max-h-[400px] overflow-y-auto">
                  {poolItems.length === 0 ? (
                    <p className="text-gray-500 text-sm">大纲池为空</p>
                  ) : (
                    poolItems.map((item) => (
                      <div
                        key={item.id}
                        className="p-3 bg-gray-50 rounded-lg hover:bg-gray-100 cursor-pointer"
                        onClick={() => handleAddChapterFromPool(item)}
                      >
                        <div className="flex items-center gap-2">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-xs bg-green-100 text-green-800">
                            {item.genre}
                          </span>
                          <span className="text-sm text-gray-500">{item.bookId}</span>
                        </div>
                        <p className="text-sm text-gray-900 mt-1 line-clamp-2">{item.outlineName}</p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}