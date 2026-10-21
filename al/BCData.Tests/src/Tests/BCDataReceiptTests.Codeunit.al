codeunit 50206 "BCD Receipt Tests"
// [FEATURE] [BC Data] E06 receipt fixture
{
    Subtype = Test;
    TestPermissions = Disabled;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure IdenticalRequestReturnsStoredResultWithoutSecondMutation()
    var
        RunId: Guid;
        Request: Text;
        FirstResult: Text;
    begin
        RunId := PrepareRun();
        Request := MutationRequest(RunId, CreateGuid(), 4, false);
        FirstResult := Probe.Execute(Request);
        Assert.AreEqual(FirstResult, Probe.Execute(Request), 'Replay must return the exact stored JSON text.');
        CheckState(RunId, 4, 1, 1);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ReusedIdWithDifferentPayloadFailsWithoutMutation()
    var
        RunId: Guid;
        RequestId: Guid;
    begin
        RunId := PrepareRun();
        RequestId := CreateGuid();
        Probe.Execute(MutationRequest(RunId, RequestId, 4, false));
        Commit();
        asserterror Probe.Execute(MutationRequest(RunId, RequestId, 5, false));
        Assert.ExpectedError('BCD_E06_REQUEST_ID_REUSED');
        CheckState(RunId, 4, 1, 1);
        Cleanup(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure LaterMutationDoesNotChangeEarlierReplayResult()
    var
        RunId: Guid;
        Request: Text;
        FirstResult: Text;
    begin
        RunId := PrepareRun();
        Request := MutationRequest(RunId, CreateGuid(), 4, false);
        FirstResult := Probe.Execute(Request);
        Probe.Execute(MutationRequest(RunId, CreateGuid(), 6, false));
        Assert.AreEqual(FirstResult, Probe.Execute(Request), 'Replay is the original result, not current counter state.');
        CheckState(RunId, 10, 2, 2);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure FailedMutationRollsBackReceiptAndCanRetrySameId()
    var
        RunId: Guid;
        RequestId: Guid;
    begin
        RunId := PrepareRun();
        RequestId := CreateGuid();
        Commit();
        asserterror Probe.Execute(MutationRequest(RunId, RequestId, 4, true));
        Assert.ExpectedError('BCD_E06_AFTER_MUTATION');
        CheckState(RunId, 0, 0, 0);
        Probe.Execute(MutationRequest(RunId, RequestId, 4, false));
        CheckState(RunId, 4, 1, 1);
        Cleanup(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoRollback)]
    procedure RequestIdIsScopedToFixtureRun()
    var
        FirstRunId: Guid;
        SecondRunId: Guid;
        RequestId: Guid;
    begin
        FirstRunId := PrepareRun();
        SecondRunId := PrepareRun();
        RequestId := CreateGuid();
        Probe.Execute(MutationRequest(FirstRunId, RequestId, 4, false));
        Probe.Execute(MutationRequest(SecondRunId, RequestId, 6, false));
        CheckState(FirstRunId, 4, 1, 1);
        CheckState(SecondRunId, 6, 1, 1);
        Cleanup(FirstRunId);
        CheckState(SecondRunId, 6, 1, 1);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure RemovingReceiptAllowsIdenticalRequestToApplyAgain()
    var
        Receipt: Record "BCD Receipt Fixture";
        RunId: Guid;
        Input: Text;
        FirstResult: Text;
        SecondResult: Text;
    begin
        // E08 negative control: deliberately forget only this completed receipt.
        // This demonstrates the missing lifetime guard; it is not a purge policy.
        RunId := PrepareRun();
        Commit();
        Input := MutationRequest(RunId, CreateGuid(), 4, false);
        FirstResult := Probe.Execute(Input);
        Commit();
        CheckState(RunId, 4, 1, 1);
        Receipt.SetRange("Run ID", RunId);
        Receipt.SetRange(Principal, UserSecurityId());
        Assert.AreEqual(1, Receipt.Count(), 'Only the owned fixture receipt is selected.');
        Receipt.FindFirst();
        Assert.IsTrue(Receipt.Completed, 'The forgotten receipt was completed.');
        Receipt.Delete();
        Commit();
        CheckState(RunId, 4, 1, 0);
        SecondResult := Probe.Execute(Input);
        Commit();
        Assert.AreNotEqual(FirstResult, SecondResult, 'Identical ID/payload is executed again after history is forgotten.');
        CheckState(RunId, 8, 2, 1);
        Cleanup(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ActiveScopeReplaysAndRejectsPrematurePurge()
    var
        RunId: Guid;
        Epoch: Text;
        Input: Text;
        Result: Text;
    begin
        PrepareScope(RunId, Epoch);
        Input := ScopedRequest(RunId, Epoch);
        Result := Scope.Execute(Input);
        Commit();
        Assert.AreEqual(Result, Scope.Execute(Input), 'Active scope returns exact completed history.');
        asserterror Scope.PurgeExpired(Input);
        Assert.ExpectedError('BCD_E08_SCOPE_ACTIVE');
        CheckState(RunId, 4, 1, 1);
        Cleanup(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure ExpiredScopeRejectsIdenticalAndNewIdsAfterReceiptPurge()
    var
        PersistedRun: Record "BCD Receipt Run";
        RunId: Guid;
        Epoch: Text;
        Input: Text;
    begin
        PrepareScope(RunId, Epoch);
        Input := ScopedRequest(RunId, Epoch);
        Scope.Execute(Input);
        Commit();
        Scope.ExpireForTest(Input);
        Commit();
        SelectLatestVersion();
        PersistedRun.ReadIsolation := IsolationLevel::ReadCommitted;
        PersistedRun.Get(RunId);
        Assert.IsTrue(PersistedRun."Retry Until" < CurrentDateTime(), 'Expiry fault must be persisted strictly in the past.');
        asserterror Scope.Execute(Input);
        Assert.ExpectedError('BCD_E08_SCOPE_EXPIRED');
        Scope.PurgeExpired(Input);
        Commit();
        CheckState(RunId, 4, 1, 0);
        asserterror Scope.Execute(Input);
        Assert.ExpectedError('BCD_E08_SCOPE_EXPIRED');
        asserterror Scope.Execute(ScopedRequest(RunId, Epoch));
        Assert.ExpectedError('BCD_E08_SCOPE_EXPIRED');
        CheckState(RunId, 4, 1, 0);
        Cleanup(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure MissingOrRetiredEpochCannotReopenRecreatedScope()
    var
        RunId: Guid;
        Epoch: Text;
        OldInput: Text;
        MissingEpoch: JsonObject;
        Prepared: JsonObject;
        Token: JsonToken;
        Input: Text;
    begin
        PrepareScope(RunId, Epoch);
        OldInput := ScopedRequest(RunId, Epoch);
        MissingEpoch.ReadFrom(OldInput);
        MissingEpoch.Remove('scopeEpoch');
        MissingEpoch.WriteTo(Input);
        asserterror Scope.Execute(Input);
        Assert.ExpectedError('BCD_E08_SCOPE_REQUIRED');
        Scope.Execute(OldInput);
        Commit();
        Cleanup(RunId);
        Commit();
        Probe.Prepare(RunRequest(RunId));
        Commit();
        asserterror Scope.Execute(Input);
        Assert.ExpectedError('BCD_E08_SCOPE_RETIRED');
        CheckState(RunId, 0, 0, 0);
        Cleanup(RunId);
        Commit();
        Prepared.ReadFrom(Scope.Prepare(RunRequest(RunId)));
        Prepared.Get('scopeEpoch', Token);
        Assert.AreNotEqual(Epoch, Token.AsValue().AsText(), 'Recreated run has a new server generation.');
        Epoch := Token.AsValue().AsText();
        Commit();
        asserterror Scope.Execute(OldInput);
        Assert.ExpectedError('BCD_E08_SCOPE_RETIRED');
        CheckState(RunId, 0, 0, 0);
        Scope.Execute(ScopedRequest(RunId, Epoch));
        Commit();
        CheckState(RunId, 4, 1, 1);
        Cleanup(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure DeadlineCrossingDuringMutationRollsBackReservation()
    var
        RunId: Guid;
        Epoch: Text;
        Request: JsonObject;
        Input: Text;
    begin
        PrepareScope(RunId, Epoch);
        Input := ScopedRequest(RunId, Epoch);
        Scope.NearDeadlineForTest(Input);
        Commit();
        Request.ReadFrom(Input);
        Request.Add('delayMs', 3000);
        Request.WriteTo(Input);
        asserterror Scope.Execute(Input);
        Assert.ExpectedError('BCD_E08_SCOPE_EXPIRED');
        CheckState(RunId, 0, 0, 0);
        Cleanup(RunId);
    end;

    [Test]
    [TransactionModel(TransactionModel::AutoCommit)]
    procedure RestoreWindowIsFixedByServerAndRetainsNormalScopeGuards()
    var
        Run: Record "BCD Receipt Run";
        RunId: Guid;
        BeforePrepare: DateTime;
        Input: Text;
        Prepared: JsonObject;
        Observed: JsonObject;
        Token: JsonToken;
        Epoch: Text;
    begin
        RunId := CreateGuid();
        BeforePrepare := CurrentDateTime();
        // Caller-supplied lifetime/epoch cannot replace the server's values.
        Input := '{"runId":"' + Format(RunId, 0, 4) + '","retryUntil":"2000-01-01T00:00:00Z","scopeEpoch":"00000000-0000-0000-0000-000000000000"}';
        Prepared.ReadFrom(Scope.PrepareRestoreForTest(Input));
        Run.Get(RunId);
        Assert.IsFalse(IsNullGuid(Run."Request Epoch"), 'Server creates the epoch.');
        // SQL DateTime persistence may round fractional milliseconds.
        Assert.IsTrue(Run."Retry Until" >= BeforePrepare + 86399000, 'Restore window is 24 hours within storage precision.');
        Assert.IsTrue(Run."Retry Until" <= CurrentDateTime() + 86401000, 'Caller cannot extend the fixed server lifetime.');
        Observed.ReadFrom(Scope.InspectScopeForTest(RunRequest(RunId)));
        Observed.Get('retryUntil', Token);
        Assert.AreEqual(Format(Run."Retry Until", 0, 9), Token.AsValue().AsText(), 'Inspection preserves exact deadline.');
        Prepared.Get('scopeEpoch', Token);
        Epoch := Token.AsValue().AsText();
        Input := ScopedRequest(RunId, Epoch);
        Scope.Execute(Input);
        Commit();
        asserterror Scope.PurgeExpired(Input);
        Assert.ExpectedError('BCD_E08_SCOPE_ACTIVE');
        Scope.ExpireForTest(Input);
        Commit();
        asserterror Scope.Execute(Input);
        Assert.ExpectedError('BCD_E08_SCOPE_EXPIRED');
        Cleanup(RunId);
    end;

    local procedure PrepareScope(var RunId: Guid; var Epoch: Text)
    var
        Prepared: JsonObject;
        Token: JsonToken;
    begin
        RunId := CreateGuid();
        Prepared.ReadFrom(Scope.Prepare(RunRequest(RunId)));
        Prepared.Get('scopeEpoch', Token);
        Epoch := Token.AsValue().AsText();
        Commit();
    end;

    local procedure ScopedRequest(RunId: Guid; Epoch: Text): Text
    var
        Request: JsonObject;
        Output: Text;
    begin
        Request.ReadFrom(MutationRequest(RunId, CreateGuid(), 4, false));
        Request.Add('scopeEpoch', Epoch);
        Request.WriteTo(Output);
        exit(Output);
    end;

    local procedure PrepareRun(): Guid
    var
        RunId: Guid;
    begin
        RunId := CreateGuid();
        Probe.Prepare(RunRequest(RunId));
        exit(RunId);
    end;

    local procedure MutationRequest(RunId: Guid; RequestId: Guid; Amount: Integer; FailAfterMutation: Boolean): Text
    var
        Request: JsonObject;
        Output: Text;
    begin
        Request.Add('runId', Format(RunId, 0, 4));
        Request.Add('requestId', Format(RequestId, 0, 4));
        Request.Add('amount', Amount);
        Request.Add('failAfterMutation', FailAfterMutation);
        Request.WriteTo(Output);
        exit(Output);
    end;

    local procedure RunRequest(RunId: Guid): Text
    begin
        exit('{"runId":"' + Format(RunId, 0, 4) + '"}');
    end;

    local procedure CheckState(RunId: Guid; ExpectedTotal: Integer; ExpectedApplies: Integer; ExpectedReceipts: Integer)
    var
        State: JsonObject;
        Token: JsonToken;
    begin
        State.ReadFrom(Probe.Inspect(RunRequest(RunId)));
        State.Get('total', Token);
        Assert.AreEqual(ExpectedTotal, Token.AsValue().AsInteger(), 'Persisted counter total.');
        State.Get('applyCount', Token);
        Assert.AreEqual(ExpectedApplies, Token.AsValue().AsInteger(), 'Mutation count.');
        State.Get('receiptCount', Token);
        Assert.AreEqual(ExpectedReceipts, Token.AsValue().AsInteger(), 'Receipt count.');
        State.Get('pendingCount', Token);
        Assert.AreEqual(0, Token.AsValue().AsInteger(), 'No incomplete receipts.');
    end;

    local procedure Cleanup(RunId: Guid)
    var
        State: JsonObject;
        Token: JsonToken;
    begin
        Probe.Cleanup(RunRequest(RunId));
        State.ReadFrom(Probe.CleanState(RunRequest(RunId)));
        State.Get('runExists', Token);
        Assert.IsFalse(Token.AsValue().AsBoolean(), 'Run removed.');
        State.Get('receiptCount', Token);
        Assert.AreEqual(0, Token.AsValue().AsInteger(), 'Receipts removed.');
    end;

    var
        Probe: Codeunit "BCD Receipt Probe";
        Scope: Codeunit "BCD Retry Scope Probe";
        Assert: Codeunit "Library Assert";
}
