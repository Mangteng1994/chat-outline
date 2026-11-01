package com.chatoutline.mobile

import com.chatoutline.mobile.fill.Variables
import org.junit.Assert.assertEquals
import org.junit.Test

class VariablesTest {
    @Test
    fun findsUniqueNamesInOrder() {
        assertEquals(listOf("a", "b"), Variables.namesIn("x {{ a }} y {{b}} {{a}}"))
    }

    @Test
    fun ignoresInvalidBraces() {
        assertEquals(emptyList<String>(), Variables.namesIn("{{}} {{ }} {{a{b}}}"))
    }

    @Test
    fun rendersKnownAndKeepsUnknown() {
        assertEquals("hi Bob, {{x}}", Variables.render("hi {{name}}, {{x}}", mapOf("name" to "Bob")))
    }
}