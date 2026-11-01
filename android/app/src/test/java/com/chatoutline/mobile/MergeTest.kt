package com.chatoutline.mobile

import com.chatoutline.mobile.data.Prompt
import com.chatoutline.mobile.data.Tombstone
import com.chatoutline.mobile.sync.SyncData
import com.chatoutline.mobile.sync.mergeData
import org.junit.Assert.assertEquals
import org.junit.Test

class MergeTest {
    private fun p(id: String, at: Long, title: String = id) = Prompt(id, title, "c", emptyList(), at)

    @Test
    fun newerVersionWins() {
        val a = SyncData(listOf(p("x", 100, "old")), emptyList())
        val b = SyncData(listOf(p("x", 200, "new")), emptyList())
        val m = mergeData(a, b, now = 300)
        assertEquals("new", m.prompts.single().title)
    }

    @Test
    fun deletionNewerThanPromptRemovesIt() {
        val a = SyncData(listOf(p("x", 100)), emptyList())
        val b = SyncData(emptyList(), listOf(Tombstone("x", 150)))
        val m = mergeData(a, b, now = 300)
        assertEquals(0, m.prompts.size)
        assertEquals(1, m.tombstones.size)
    }

    @Test
    fun editNewerThanDeletionRestoresPromptAndDropsTombstone() {
        val a = SyncData(listOf(p("x", 200)), emptyList())
        val b = SyncData(emptyList(), listOf(Tombstone("x", 150)))
        val m = mergeData(a, b, now = 300)
        assertEquals(1, m.prompts.size)
        assertEquals(0, m.tombstones.size)
    }

    @Test
    fun oldTombstonesAreDropped() {
        val old = Tombstone("y", 0)
        val m = mergeData(SyncData(emptyList(), listOf(old)), SyncData(emptyList(), emptyList()), now = 181L * 24 * 3600 * 1000)
        assertEquals(0, m.tombstones.size)
    }
}
