codeunit 50205 "BCD Commit Tests"
// [FEATURE] [BC Data] E07 commit boundaries
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ExplicitCommitCanSeparateMutationFromReceipt()
    var
        Header: Record "BCD Probe Header";
    begin
        // [SCENARIO] An explicit commit preserves the mutation despite a later receipt failure.
        Initialize(Header, 'explicit');
        asserterror UnguardedMutationAndFailure(Header);
        Assert.ExpectedError('BCD_E07_AFTER_MUTATION');
        CheckAndClean(Header, true, false);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ErrorPolicyRejectsExplicitCommitAndRollsBack()
    var
        Header: Record "BCD Probe Header";
    begin
        // [SCENARIO] Error policy rejects the explicit commit before the receipt stage.
        Initialize(Header, 'explicit');
        asserterror ErrorGuardedMutationAndFailure(Header, false);
        Assert.IsTrue(StrPos(LowerCase(GetLastErrorText()), 'commit') > 0,
            'The rejected explicit commit must be the reported failure.');
        CheckAndClean(Header, false, false);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure IgnorePolicySuppressesExplicitCommitUntilLaterError()
    var
        Header: Record "BCD Probe Header";
    begin
        // [SCENARIO] Ignore differs from Error: execution reaches the later error, then both rows roll back.
        Initialize(Header, 'explicit');
        asserterror IgnoreGuardedMutationAndFailure(Header);
        Assert.ExpectedError('BCD_E07_AFTER_MUTATION');
        CheckAndClean(Header, false, false);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ErrorPolicyDoesNotPreventBooleanRunImplicitCommit()
    var
        Header: Record "BCD Probe Header";
    begin
        // [SCENARIO] Boolean Codeunit.Run commits before the outer receipt/error even under Error policy.
        Initialize(Header, 'implicit');
        asserterror ErrorGuardedMutationAndFailure(Header, true);
        Assert.ExpectedError('BCD_E07_AFTER_MUTATION');
        CheckAndClean(Header, true, false);
    end;

    local procedure Initialize(var Header: Record "BCD Probe Header"; Mode: Text)
    begin
        Header.Init();
        Header."Run ID" := CreateGuid();
        Header."Line No." := 1;
        Header."Probe Text" := CopyStr(Mode, 1, MaxStrLen(Header."Probe Text"));
        // Boolean Codeunit.Run requires no active write transaction.
        Commit();
    end;

    local procedure UnguardedMutationAndFailure(var Header: Record "BCD Probe Header")
    var
        Probe: Codeunit "BCD Commit Probe";
    begin
        Probe.Run(Header);
        InsertReceiptAndFail(Header);
    end;

    [CommitBehavior(CommitBehavior::Error)]
    local procedure ErrorGuardedMutationAndFailure(var Header: Record "BCD Probe Header"; UseBooleanRun: Boolean)
    var
        Probe: Codeunit "BCD Commit Probe";
    begin
        if UseBooleanRun then begin
            if not Probe.Run(Header) then
                Error(GetLastErrorText());
        end else
            Probe.Run(Header);
        InsertReceiptAndFail(Header);
    end;

    [CommitBehavior(CommitBehavior::Ignore)]
    local procedure IgnoreGuardedMutationAndFailure(var Header: Record "BCD Probe Header")
    var
        Probe: Codeunit "BCD Commit Probe";
    begin
        Probe.Run(Header);
        InsertReceiptAndFail(Header);
    end;

    local procedure InsertReceiptAndFail(Header: Record "BCD Probe Header")
    var
        Receipt: Record "BCD Probe Header";
    begin
        // A second fixture row stands in for a receipt; no production receipt contract is implemented.
        Receipt.Init();
        Receipt."Run ID" := Header."Run ID";
        Receipt."Line No." := 2;
        Receipt.Insert();
        Error('BCD_E07_AFTER_MUTATION');
    end;

    local procedure CheckAndClean(Header: Record "BCD Probe Header"; ExpectedMutation: Boolean; ExpectedReceipt: Boolean)
    var
        Stored: Record "BCD Probe Header";
        MutationExists: Boolean;
        ReceiptExists: Boolean;
    begin
        MutationExists := Stored.Get(Header."Run ID", 1);
        ReceiptExists := Stored.Get(Header."Run ID", 2);
        Stored.SetRange("Run ID", Header."Run ID");
        Stored.DeleteAll();
        Commit();
        Assert.AreEqual(ExpectedMutation, MutationExists, 'Mutation after the outer error.');
        Assert.AreEqual(ExpectedReceipt, ReceiptExists, 'Receipt after the outer error.');
        Assert.IsTrue(Stored.IsEmpty(), 'Only this run was cleaned.');
    end;

    var
        Assert: Codeunit "Library Assert";
}
